import { useMemo, useState, type FormEvent } from "react";
import { Plus, Trash2, X } from "lucide-react";
import type {
  WebhookContentType,
  WebhookInput,
  WebhookMethod,
  WebhookSigning,
  WebhookView,
} from "../../shared/webhook-api";
import {
  filtersMatch,
  type WebhookFilters,
} from "../../shared/webhook-filters";
import {
  renderTemplate,
  TEMPLATE_HELPERS,
  TemplateError,
} from "../../shared/webhook-template";
import {
  sampleEvent,
  WEBHOOK_EVENT_GROUPS,
  WEBHOOK_EVENT_LABELS,
  WEBHOOK_PRESETS,
  type WebhookEventType,
  type WebhookPresetId,
} from "../../shared/webhooks";

const FILTER_FIELDS = [
  ["repositories", "Repositories", "acme/api\nacme/*"],
  ["branches", "Branches", "main\nrelease/*"],
  ["environments", "Environments", "production"],
  ["services", "Services", "Public API"],
  ["actors", "People", "!*[bot]"],
] as const;
type FilterKey = (typeof FILTER_FIELDS)[number][0];
type SecretMode = "keep" | "generate" | "custom" | "remove" | "none";

const lines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** 0, true, and "quoted" text are JSON; anything else is a plain string. */
function parseValue(value: string): string | number | boolean | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "string" ||
      typeof parsed === "number" ||
      typeof parsed === "boolean"
      ? parsed
      : trimmed;
  } catch {
    return trimmed;
  }
}

export const eventLabel = (type: string) =>
  WEBHOOK_EVENT_LABELS[type as WebhookEventType] ??
  (type.startsWith("inbound.") ? `Inbound: ${type.slice(8)}` : type);

const VARIABLES: [string, string][] = [
  ["summary", "One line for people"],
  ["url", "The page to open, when there is one"],
  ["type", "Such as incident.opened"],
  ["occurredAt", "ISO timestamp"],
  ["workspace.name", "This workspace"],
  ["data.…", "Event details; see the preview's sample"],
  ["@delivery.attempt", "1 for the first try"],
  ["@delivery.timestamp", "Unix seconds, signed with the body"],
  ["@delivery.larkSign", "Lark's sign field when Lark signing is on"],
];

export function WebhookEditor({
  webhook,
  workspace,
  inboundSlugs,
  onSave,
  onCancel,
  onDelete,
}: {
  webhook?: WebhookView;
  workspace: { id: string; name: string };
  inboundSlugs: string[];
  onSave: (input: WebhookInput) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => Promise<void>;
}) {
  const isNew = !webhook;
  const [name, setName] = useState(webhook?.name ?? "");
  const [preset, setPreset] = useState<WebhookPresetId | "custom">(
    webhook?.preset ?? "slack",
  );
  const [url, setUrl] = useState("");
  const [method, setMethod] = useState<WebhookMethod>(
    webhook?.method ?? "POST",
  );
  const [contentType, setContentType] = useState<WebhookContentType>(
    webhook?.contentType ?? "application/json",
  );
  const [template, setTemplate] = useState(
    webhook?.template ?? WEBHOOK_PRESETS.slack.template,
  );
  const [events, setEvents] = useState<string[]>(
    webhook?.events ?? ["incident.opened", "incident.resolved"],
  );
  const [filterText, setFilterText] = useState(
    () =>
      Object.fromEntries(
        FILTER_FIELDS.map(([key]) => [
          key,
          (webhook?.filters[key] ?? []).join("\n"),
        ]),
      ) as Record<FilterKey, string>,
  );
  const [summaryText, setSummaryText] = useState(webhook?.filters.text ?? "");
  const [cooldown, setCooldown] = useState(
    String(webhook?.cooldownSeconds ?? 0),
  );
  const [signing, setSigning] = useState<WebhookSigning>(
    webhook?.signing ?? "ship",
  );
  const [secretMode, setSecretMode] = useState<SecretMode>(
    webhook ? "keep" : "none",
  );
  const [customSecret, setCustomSecret] = useState("");
  const [successPath, setSuccessPath] = useState(webhook?.successPath ?? "");
  const [successValue, setSuccessValue] = useState(
    webhook && webhook.successValue !== null
      ? JSON.stringify(webhook.successValue)
      : "",
  );
  const [replaceHeaders, setReplaceHeaders] = useState(isNew);
  const [headers, setHeaders] = useState<{ name: string; value: string }[]>([]);
  const [enabled, setEnabled] = useState(webhook?.enabled ?? true);
  const [previewType, setPreviewType] = useState(
    webhook?.events[0] ?? "incident.opened",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function choosePreset(next: WebhookPresetId | "custom") {
    setPreset(next);
    if (next === "custom") return;
    const chosen = WEBHOOK_PRESETS[next];
    setTemplate(chosen.template);
    setContentType("application/json");
    setMethod("POST");
    setSigning(chosen.signing ?? "ship");
    setSuccessPath(chosen.success?.path ?? "");
    setSuccessValue(chosen.success ? JSON.stringify(chosen.success.value) : "");
    // A generic receiver can verify ship.live's signature; chat services
    // cannot, and Lark uses the bot's own secret.
    if (isNew) setSecretMode(next === "generic" ? "generate" : "none");
  }

  const filters = useMemo<WebhookFilters>(() => {
    const result: WebhookFilters = {};
    for (const [key] of FILTER_FIELDS) {
      const patterns = lines(filterText[key]);
      if (patterns.length) result[key] = patterns;
    }
    if (summaryText.trim()) result.text = summaryText.trim();
    return result;
  }, [filterText, summaryText]);
  const hasSecret =
    secretMode === "generate" ||
    secretMode === "custom" ||
    (secretMode === "keep" && Boolean(webhook?.hasSecret));
  const mode = contentType === "application/json" ? "json" : "text";
  const sample = useMemo(
    () => sampleEvent(previewType, workspace),
    [previewType, workspace],
  );
  const preview = useMemo(() => {
    try {
      const output = renderTemplate(template, sample, mode, {
        delivery: {
          id: "preview",
          attempt: 1,
          timestamp: String(Math.floor(Date.now() / 1000)),
          ...(signing === "lark" && hasSecret
            ? { larkSign: "(computed when sent)" }
            : {}),
        },
      });
      return {
        output:
          mode === "json"
            ? JSON.stringify(JSON.parse(output), null, 2)
            : output,
        error: "",
      };
    } catch (failure) {
      return {
        output: "",
        error:
          failure instanceof TemplateError
            ? failure.message
            : "The template could not render.",
      };
    }
  }, [template, sample, mode, signing, hasSecret]);
  const sampleMatches = filtersMatch(filters, sample);
  const eventTypes = WEBHOOK_EVENT_GROUPS.map((group) => ({
    ...group,
    types: [
      ...group.types,
      ...(group.id === "inbound"
        ? inboundSlugs.map((slug) => `inbound.${slug}`)
        : []),
    ] as string[],
  }));

  function toggle(type: string) {
    setEvents((current) =>
      current.includes(type)
        ? current.filter((item) => item !== type)
        : [...current, type],
    );
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const input: WebhookInput = {
      name,
      preset,
      method,
      contentType,
      template,
      signing,
      successPath: successPath.trim(),
      successValue: successPath.trim() ? parseValue(successValue) : null,
      events,
      filters,
      cooldownSeconds: Math.max(0, Math.round(Number(cooldown) || 0)),
      enabled,
      ...(url.trim() ? { url: url.trim() } : {}),
      ...(replaceHeaders
        ? {
            headers: Object.fromEntries(
              headers
                .filter((row) => row.name.trim())
                .map((row) => [row.name.trim(), row.value]),
            ),
          }
        : {}),
      ...(secretMode === "generate"
        ? { secret: "generate" }
        : secretMode === "custom"
          ? { secret: customSecret }
          : secretMode === "remove"
            ? { secret: "" }
            : {}),
    };
    try {
      await onSave(input);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save.");
      setBusy(false);
    }
  }

  const presetHint =
    preset === "custom"
      ? "Write any body. JSON bodies must render valid JSON for every event you choose."
      : WEBHOOK_PRESETS[preset].hint;

  return (
    <form className="webhook-form" onSubmit={save}>
      <fieldset disabled={busy} className="webhook-form-fields">
        <div className="webhook-form-grid">
          <label>
            Name
            <input
              value={name}
              maxLength={80}
              required
              onChange={(e) => setName(e.target.value)}
              placeholder="Incidents to #ops"
            />
          </label>
          <label>
            Preset
            <select
              value={preset}
              onChange={(e) =>
                choosePreset(e.target.value as WebhookPresetId | "custom")
              }
            >
              {Object.values(WEBHOOK_PRESETS).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
              <option value="custom">Custom</option>
            </select>
          </label>
          <label className="webhook-wide">
            URL
            <input
              type="url"
              value={url}
              required={isNew}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={
                webhook
                  ? `Saved: ${webhook.urlHint} — leave empty to keep`
                  : "https://hooks.slack.com/services/…"
              }
            />
          </label>
        </div>
        <p className="field-hint">{presetHint}</p>

        <h4>Events</h4>
        <div className="webhook-events">
          {eventTypes.map((group) => (
            <fieldset key={group.id} className="webhook-event-group">
              <legend>{group.label}</legend>
              {group.types.map((type) => (
                <label key={type} className="webhook-check">
                  <input
                    type="checkbox"
                    checked={events.includes(type)}
                    onChange={() => toggle(type)}
                  />
                  {eventLabel(type)}
                </label>
              ))}
            </fieldset>
          ))}
        </div>

        <details
          className="webhook-section"
          open={Boolean(webhook && Object.keys(webhook.filters).length)}
        >
          <summary>Filters and cooldown</summary>
          <p className="field-hint">
            One pattern per line. * matches anything and a leading ! excludes. A
            filter applies only to events that have its field, so an environment
            filter leaves activity alone.
          </p>
          <div className="webhook-form-grid">
            {FILTER_FIELDS.map(([key, label, placeholder]) => (
              <label key={key}>
                {label}
                <textarea
                  rows={2}
                  value={filterText[key]}
                  placeholder={placeholder}
                  onChange={(e) =>
                    setFilterText({ ...filterText, [key]: e.target.value })
                  }
                />
              </label>
            ))}
            <label>
              Summary contains
              <input
                value={summaryText}
                maxLength={200}
                onChange={(e) => setSummaryText(e.target.value)}
                placeholder="hotfix"
              />
            </label>
            <label>
              Cooldown (seconds)
              <input
                type="number"
                min={0}
                max={86400}
                step={60}
                value={cooldown}
                onChange={(e) => setCooldown(e.target.value)}
              />
            </label>
          </div>
          <p className="field-hint">
            During a cooldown, repeated alerts about the same probe, pipeline,
            deployment environment, or inbound source are skipped. A recovery
            always sends and ends it.
          </p>
        </details>

        <details className="webhook-section">
          <summary>Request, signing, and headers</summary>
          <div className="webhook-form-grid">
            <label>
              Method
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value as WebhookMethod)}
              >
                <option>POST</option>
                <option>PUT</option>
                <option>PATCH</option>
              </select>
            </label>
            <label>
              Content type
              <select
                value={contentType}
                onChange={(e) =>
                  setContentType(e.target.value as WebhookContentType)
                }
              >
                <option value="application/json">application/json</option>
                <option value="text/plain">text/plain</option>
                <option value="application/x-www-form-urlencoded">
                  application/x-www-form-urlencoded
                </option>
              </select>
            </label>
            <label>
              Signing
              <select
                value={signing}
                onChange={(e) => setSigning(e.target.value as WebhookSigning)}
              >
                <option value="ship">X-Ship-Signature header</option>
                <option value="lark">Lark / Feishu (in the body)</option>
              </select>
            </label>
            <label>
              Secret
              <select
                value={secretMode}
                onChange={(e) => setSecretMode(e.target.value as SecretMode)}
              >
                {webhook?.hasSecret && (
                  <option value="keep">Keep saved secret</option>
                )}
                {!webhook?.hasSecret && (
                  <option value={webhook ? "keep" : "none"}>No secret</option>
                )}
                <option value="generate">Generate a new secret</option>
                <option value="custom">Paste a secret</option>
                {webhook?.hasSecret && (
                  <option value="remove">Remove secret</option>
                )}
              </select>
            </label>
            {secretMode === "custom" && (
              <label className="webhook-wide">
                {signing === "lark" ? "Lark bot secret" : "Secret"}
                <input
                  type="password"
                  autoComplete="off"
                  minLength={8}
                  maxLength={512}
                  required
                  value={customSecret}
                  onChange={(e) => setCustomSecret(e.target.value)}
                />
              </label>
            )}
          </div>
          <p className="field-hint">
            {signing === "lark"
              ? "With a secret, ship.live adds Lark's timestamp and sign fields to the body; the Lark preset places them with {{@delivery.timestamp}} and {{@delivery.larkSign}}."
              : 'With a secret, each request carries X-Ship-Timestamp and X-Ship-Signature: v1=<hex HMAC-SHA256 of "<timestamp>.<body>">.'}
          </p>
          <div className="webhook-form-grid">
            <label>
              Success check (JSON path)
              <input
                value={successPath}
                onChange={(e) => setSuccessPath(e.target.value)}
                placeholder="code"
              />
            </label>
            <label>
              Expected value
              <input
                value={successValue}
                disabled={!successPath.trim()}
                onChange={(e) => setSuccessValue(e.target.value)}
                placeholder="0"
              />
            </label>
          </div>
          <p className="field-hint">
            Without a check, any 2xx response succeeds. Some services answer 200
            with an error code in the body; Lark, for example, needs code = 0.
          </p>
          <div className="webhook-headers">
            <span className="webhook-label">Headers</span>
            {webhook && webhook.headerNames.length > 0 && !replaceHeaders ? (
              <p className="field-hint">
                Saved: {webhook.headerNames.join(", ")}. Values stay hidden.{" "}
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setReplaceHeaders(true)}
                >
                  Replace headers
                </button>
              </p>
            ) : (
              <>
                {headers.map((row, index) => (
                  <div key={index} className="webhook-header-row">
                    <input
                      aria-label="Header name"
                      placeholder="Authorization"
                      value={row.name}
                      onChange={(e) =>
                        setHeaders(
                          headers.map((item, position) =>
                            position === index
                              ? { ...item, name: e.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                    <input
                      aria-label="Header value"
                      type="password"
                      autoComplete="off"
                      placeholder="Bearer …"
                      value={row.value}
                      onChange={(e) =>
                        setHeaders(
                          headers.map((item, position) =>
                            position === index
                              ? { ...item, value: e.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Remove header"
                      onClick={() =>
                        setHeaders(
                          headers.filter((_, position) => position !== index),
                        )
                      }
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setReplaceHeaders(true);
                    setHeaders([...headers, { name: "", value: "" }]);
                  }}
                >
                  <Plus size={13} /> Add header
                </button>
              </>
            )}
          </div>
        </details>

        <h4>Body template</h4>
        <div className="webhook-template">
          <label className="webhook-template-editor">
            <span className="sr-only">Body template</span>
            <textarea
              spellCheck={false}
              value={template}
              onChange={(e) => {
                setTemplate(e.target.value);
                if (
                  preset !== "custom" &&
                  e.target.value !== WEBHOOK_PRESETS[preset].template
                )
                  setPreset("custom");
              }}
            />
          </label>
          <div className="webhook-preview">
            <label>
              Preview with
              <select
                value={previewType}
                onChange={(e) => setPreviewType(e.target.value)}
              >
                {eventTypes.flatMap((group) =>
                  group.types.map((type) => (
                    <option key={type} value={type}>
                      {eventLabel(type)}
                    </option>
                  )),
                )}
                <option value="webhook.test">Test delivery</option>
              </select>
            </label>
            {preview.error ? (
              <p className="form-error" role="alert">
                {preview.error}
              </p>
            ) : (
              <pre aria-label="Rendered body">{preview.output}</pre>
            )}
            {!sampleMatches && (
              <p className="field-hint">Your filters would skip this sample.</p>
            )}
          </div>
        </div>
        <details className="webhook-section">
          <summary>Variables and helpers</summary>
          <div className="webhook-reference">
            <dl>
              {VARIABLES.map(([variable, meaning]) => (
                <div key={variable}>
                  <dt>
                    <code>{`{{${variable}}}`}</code>
                  </dt>
                  <dd>{meaning}</dd>
                </div>
              ))}
            </dl>
            <dl>
              {Object.entries(TEMPLATE_HELPERS).map(([helper, details]) => (
                <div key={helper}>
                  <dt>
                    <code>{helper}</code>
                  </dt>
                  <dd>{details.description}</dd>
                </div>
              ))}
            </dl>
          </div>
          <p className="field-hint">
            Blocks: {"{{#if value}}…{{else}}…{{/if}}"},{" "}
            {"{{#each list}}…{{/each}}"} with @index, and{" "}
            {"{{#with value}}…{{/with}}"}. Helpers nest:{" "}
            {'{{#if (eq data.status "down")}}'}. In JSON bodies, inserted text
            is escaped for a JSON string; {"{{json value}}"} inserts a whole
            value.
          </p>
        </details>

        <label className="settings-toggle">
          <span>Send deliveries</span>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
        </label>
        {webhook?.pausedReason && (
          <p className="field-hint">
            Paused: {webhook.pausedReason} Turning it on and saving resumes it.
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="webhook-form-actions">
          <button
            className="button primary"
            type="submit"
            disabled={!events.length || Boolean(preview.error)}
          >
            {isNew ? "Create webhook" : "Save webhook"}
          </button>
          <button className="button secondary" type="button" onClick={onCancel}>
            Cancel
          </button>
          {onDelete && (
            <button
              type="button"
              className="text-button danger-button"
              onClick={async () => {
                if (!window.confirm(`Delete ${webhook?.name}?`)) return;
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
