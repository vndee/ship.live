import { useMemo, useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import type {
  InboundHookInput,
  InboundHookView,
  InboundMapping,
} from "../../shared/webhook-api";
import { renderTemplate, TemplateError } from "../../shared/webhook-template";

const SAMPLE = JSON.stringify(
  {
    id: "alert-1",
    title: "API latency above 800 ms",
    state: "alerting",
    message: "p95 latency has been above 800 ms for 5 minutes.",
    url: "https://grafana.example.com/alerting/1",
  },
  null,
  2,
);
const FIELDS: [keyof InboundMapping, string, string][] = [
  ["title", "Title", "Required. Becomes the event summary."],
  ["body", "Details", "Optional longer text, such as an alert message."],
  ["url", "Link", "Optional. Kept only when it renders an https URL."],
  [
    "id",
    "Delivery ID",
    "Optional. Requests that render the same ID count once, so sender retries do not repeat.",
  ],
];

export function InboundEditor({
  hook,
  onSave,
  onCancel,
  onDelete,
}: {
  hook?: InboundHookView;
  onSave: (input: InboundHookInput) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => Promise<void>;
}) {
  const [name, setName] = useState(hook?.name ?? "");
  const [slug, setSlug] = useState(hook?.slug ?? "");
  const [mapping, setMapping] = useState<InboundMapping>(
    hook?.mapping ?? {
      title: "{{payload.title}}",
      body: "{{payload.message}}",
      url: "{{payload.url}}",
      id: "{{payload.id}}",
    },
  );
  const [secretMode, setSecretMode] = useState<
    "keep" | "generate" | "remove" | "none"
  >(hook ? "keep" : "none");
  const [sample, setSample] = useState(SAMPLE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const preview = useMemo(() => {
    let payload: unknown;
    try {
      payload = JSON.parse(sample);
    } catch {
      return { error: "The sample is not JSON.", values: null };
    }
    try {
      return {
        error: "",
        values: Object.fromEntries(
          FIELDS.map(([key]) => [
            key,
            mapping[key]
              ? renderTemplate(mapping[key], { payload }, "text").trim()
              : "",
          ]),
        ) as unknown as InboundMapping,
      };
    } catch (failure) {
      return {
        error:
          failure instanceof TemplateError
            ? failure.message
            : "The mapping could not render.",
        values: null,
      };
    }
  }, [mapping, sample]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSave({
        name,
        slug,
        mapping,
        ...(secretMode === "generate"
          ? { secret: "generate" }
          : secretMode === "remove"
            ? { secret: "" }
            : {}),
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save.");
      setBusy(false);
    }
  }

  return (
    <form className="webhook-form" onSubmit={save}>
      <fieldset disabled={busy} className="webhook-form-fields">
        <div className="webhook-form-grid">
          <label>
            Name
            <input
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Grafana alerts"
            />
          </label>
          <label>
            Slug
            <input
              required
              disabled={Boolean(hook)}
              pattern="[a-z0-9][a-z0-9-]{0,39}"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder="grafana"
            />
          </label>
        </div>
        <p className="field-hint">
          Events arrive as inbound.{slug || "slug"}. Outbound webhooks that
          listen for them pass them on with their own templates.
        </p>
        <h4>Map the payload</h4>
        <p className="field-hint">
          Templates read the request body as payload, such as{" "}
          {"{{payload.alerts.0.labels.alertname}}"}.
        </p>
        <div className="webhook-form-grid">
          {FIELDS.map(([key, label, hint]) => (
            <label key={key} className="webhook-wide">
              {label}
              <input
                className="webhook-code"
                spellCheck={false}
                value={mapping[key]}
                required={key === "title"}
                onChange={(e) =>
                  setMapping({ ...mapping, [key]: e.target.value })
                }
              />
              <small>{hint}</small>
            </label>
          ))}
        </div>
        <div className="webhook-template">
          <label className="webhook-template-editor">
            Sample payload
            <textarea
              spellCheck={false}
              value={sample}
              onChange={(e) => setSample(e.target.value)}
            />
          </label>
          <div className="webhook-preview">
            <span className="webhook-label">Result</span>
            {preview.error ? (
              <p className="form-error" role="alert">
                {preview.error}
              </p>
            ) : (
              <dl className="inbound-preview">
                {FIELDS.map(([key, label]) => (
                  <div key={key}>
                    <dt>{label}</dt>
                    <dd>{preview.values?.[key] || "—"}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </div>
        <label className="webhook-secret-choice">
          Signature
          <select
            value={secretMode}
            onChange={(e) => setSecretMode(e.target.value as typeof secretMode)}
          >
            {hook?.hasSecret ? (
              <option value="keep">Keep saved secret</option>
            ) : (
              <option value={hook ? "keep" : "none"}>
                Not required (the URL is the credential)
              </option>
            )}
            <option value="generate">Require a new secret</option>
            {hook?.hasSecret && (
              <option value="remove">Stop requiring it</option>
            )}
          </select>
        </label>
        <p className="field-hint">
          With a secret, requests must send X-Signature-256: sha256=&lt;hex
          HMAC-SHA256 of the body&gt;, as GitHub does.
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="webhook-form-actions">
          <button className="button primary" type="submit">
            {hook ? "Save inbound webhook" : "Create inbound webhook"}
          </button>
          <button className="button secondary" type="button" onClick={onCancel}>
            Cancel
          </button>
          {onDelete && (
            <button
              type="button"
              className="text-button danger-button"
              onClick={async () => {
                if (
                  !window.confirm(
                    `Delete ${hook?.name}? Its URL stops working.`,
                  )
                )
                  return;
                setBusy(true);
                try {
                  await onDelete();
                } catch (failure) {
                  setError(
                    failure instanceof Error
                      ? failure.message
                      : "Could not delete.",
                  );
                  setBusy(false);
                }
              }}
            >
              <Trash2 size={14} /> Delete
            </button>
          )}
        </div>
      </fieldset>
    </form>
  );
}
