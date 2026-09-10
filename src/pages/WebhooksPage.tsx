import { useState } from "react";
import { Copy, Inbox, Plus, RotateCcw, Webhook } from "lucide-react";
import type { InboundHookView, WebhookView } from "../../shared/webhook-api";
import { WEBHOOK_PRESETS } from "../../shared/webhooks";
import { useWebhooks } from "../hooks/useWebhooks";
import { ago } from "../lib/format";
import { DeliveryLog, DeliveryStatus } from "../components/DeliveryLog";
import { InboundEditor } from "../components/InboundEditor";
import { Modal } from "../components/Modal";
import { WebhookEditor } from "../components/WebhookEditor";
import "../components/webhooks.css";

interface Reveal {
  title: string;
  items: [label: string, value: string][];
}

function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="copy-value">
      <code>{value}</code>
      <button
        className="icon-button"
        aria-label="Copy"
        title="Copy"
        onClick={async () => {
          await navigator.clipboard?.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        <Copy size={14} />
      </button>
      {copied && <span className="copy-done">Copied</span>}
    </span>
  );
}

/** Outbound and inbound webhooks for a team workspace. */
export function WebhooksPage({
  workspace,
  csrfToken,
}: {
  workspace: { id: string; name: string };
  csrfToken: string;
}) {
  const controller = useWebhooks(workspace.id, csrfToken);
  const { settings } = controller;
  const [editing, setEditing] = useState<WebhookView | "new" | null>(null);
  const [log, setLog] = useState<WebhookView | null>(null);
  const [inbound, setInbound] = useState<InboundHookView | "new" | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const now = Date.now();
  const slugs = settings?.inbound.map((hook) => hook.slug) ?? [];
  const presetName = (id: string) =>
    id === "custom"
      ? "Custom"
      : (WEBHOOK_PRESETS[id as keyof typeof WEBHOOK_PRESETS]?.name ?? id);

  return (
    <section className="webhooks-page" aria-labelledby="webhooks-title">
      <div className="section-heading">
        <h2 id="webhooks-title">
          <Webhook size={19} /> Outbound webhooks{" "}
          <span className="section-count">
            {settings?.webhooks.length ?? 0}
          </span>
        </h2>
        <button
          className="button secondary"
          disabled={!settings?.configured}
          onClick={() => setEditing("new")}
        >
          <Plus size={15} /> New webhook
        </button>
      </div>
      <p className="webhooks-intro">
        Send merges, reviews, releases, CI and deployment changes, Service
        Health incidents, inbound alerts, and a weekly digest to Slack, Discord,
        Microsoft Teams, Google Chat, Lark, or any URL. Every body is a template
        you can change.
      </p>
      {settings && !settings.configured && (
        <div className="notice error-notice" role="alert">
          Webhooks need TOKEN_ENCRYPTION_KEY on the server to store URLs and
          secrets.
        </div>
      )}
      {controller.error && (
        <div className="notice error-notice" role="alert">
          {controller.error}
        </div>
      )}
      {reveal && (
        <div className="notice webhook-reveal" role="status">
          <strong>{reveal.title}</strong>
          {reveal.items.map(([label, value]) => (
            <div key={label}>
              <span>{label}</span>
              <CopyValue value={value} />
            </div>
          ))}
          <p className="field-hint">This is shown once. Store it now.</p>
          <button className="text-button" onClick={() => setReveal(null)}>
            Done
          </button>
        </div>
      )}
      {settings && !settings.webhooks.length && (
        <div className="empty-state">
          <Webhook size={24} />
          <h3>No outbound webhooks yet</h3>
          <p>Start with a preset, then adjust events, filters, and the body.</p>
        </div>
      )}
      <div className="webhook-list">
        {settings?.webhooks.map((webhook) => (
          <article key={webhook.id} className="webhook-row">
            <div className="webhook-main">
              <strong>{webhook.name}</strong>
              <span className="webhook-meta">
                {presetName(webhook.preset)} · {webhook.method}{" "}
                {webhook.urlHint}
              </span>
              <span className="webhook-meta">
                {webhook.events.length} event
                {webhook.events.length === 1 ? "" : "s"}
                {webhook.cooldownSeconds
                  ? ` · ${Math.round(webhook.cooldownSeconds / 60)} min cooldown`
                  : ""}
                {webhook.creator.name
                  ? ` · saved by ${webhook.creator.name}`
                  : ""}
              </span>
            </div>
            <div className="webhook-state">
              {webhook.pausedReason ? (
                <span className="webhook-status-chip failed">Paused</span>
              ) : !webhook.enabled ? (
                <span className="webhook-status-chip skipped">Off</span>
              ) : webhook.lastDelivery ? (
                <>
                  <DeliveryStatus status={webhook.lastDelivery.status} />
                  <span className="webhook-meta">
                    {ago(
                      webhook.lastDelivery.finishedAt ??
                        webhook.lastDelivery.createdAt,
                      now,
                    )}
                  </span>
                </>
              ) : (
                <span className="webhook-meta">No deliveries yet</span>
              )}
            </div>
            <div className="webhook-actions">
              <button className="text-button" onClick={() => setLog(webhook)}>
                Deliveries
              </button>
              <button
                className="text-button"
                onClick={() => setEditing(webhook)}
              >
                Edit
              </button>
            </div>
          </article>
        ))}
      </div>

      <div className="section-heading webhooks-inbound-heading">
        <h2>
          <Inbox size={19} /> Inbound webhooks{" "}
          <span className="section-count">{settings?.inbound.length ?? 0}</span>
        </h2>
        <button
          className="button secondary"
          disabled={!settings?.configured}
          onClick={() => setInbound("new")}
        >
          <Plus size={15} /> New inbound webhook
        </button>
      </div>
      <p className="webhooks-intro">
        Receive JSON from Grafana, Sentry, a CI system, or any service. Map it
        to a title, details, and link, and pass it on through your outbound
        webhooks.
      </p>
      <div className="webhook-list">
        {settings?.inbound.map((hook) => (
          <article key={hook.id} className="webhook-row">
            <div className="webhook-main">
              <strong>{hook.name}</strong>
              <span className="webhook-meta">
                inbound.{hook.slug}
                {hook.hasSecret ? " · signed" : ""}
                {hook.creator.name ? ` · created by ${hook.creator.name}` : ""}
              </span>
              {hook.receipts.length > 0 && (
                <details className="inbound-receipts">
                  <summary>
                    Last received {ago(hook.receipts[0].receivedAt, now)}
                  </summary>
                  <ul>
                    {hook.receipts.map((receipt) => (
                      <li key={receipt.id}>
                        <DeliveryStatus
                          status={receipt.accepted ? "succeeded" : "failed"}
                        />
                        <span>{receipt.summary ?? receipt.error}</span>
                        <span className="webhook-meta">
                          {ago(receipt.receivedAt, now)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
            <div className="webhook-actions">
              <button
                className="text-button"
                onClick={async () => {
                  if (
                    !window.confirm(
                      `Issue a new URL for ${hook.name}? The current one stops working.`,
                    )
                  )
                    return;
                  const saved = await controller.rotateInbound(hook.id);
                  if (saved.endpoint)
                    setReveal({
                      title: `New URL for ${hook.name}`,
                      items: [["Endpoint", saved.endpoint]],
                    });
                }}
              >
                <RotateCcw size={13} /> New URL
              </button>
              <button className="text-button" onClick={() => setInbound(hook)}>
                Edit
              </button>
            </div>
          </article>
        ))}
      </div>

      {editing && (
        <Modal
          wide
          title={editing === "new" ? "New webhook" : `Edit ${editing.name}`}
          onClose={() => setEditing(null)}
        >
          <WebhookEditor
            webhook={editing === "new" ? undefined : editing}
            workspace={workspace}
            inboundSlugs={slugs}
            onCancel={() => setEditing(null)}
            onSave={async (input) => {
              const saved = await controller.save(
                input,
                editing === "new" ? undefined : editing.id,
              );
              setEditing(null);
              if (saved.secret)
                setReveal({
                  title: `Signing secret for ${saved.webhook.name}`,
                  items: [["Secret", saved.secret]],
                });
            }}
            onDelete={
              editing === "new"
                ? undefined
                : async () => {
                    await controller.remove(editing.id);
                    setEditing(null);
                  }
            }
          />
        </Modal>
      )}
      {log && (
        <Modal
          wide
          title={`${log.name} deliveries`}
          onClose={() => setLog(null)}
        >
          <DeliveryLog webhook={log} controller={controller} />
        </Modal>
      )}
      {inbound && (
        <Modal
          wide
          title={
            inbound === "new" ? "New inbound webhook" : `Edit ${inbound.name}`
          }
          onClose={() => setInbound(null)}
        >
          <InboundEditor
            hook={inbound === "new" ? undefined : inbound}
            onCancel={() => setInbound(null)}
            onSave={async (input) => {
              const saved = await controller.saveInbound(
                input,
                inbound === "new" ? undefined : inbound.id,
              );
              setInbound(null);
              const items: [string, string][] = [];
              if (saved.endpoint) items.push(["Endpoint", saved.endpoint]);
              if (saved.secret) items.push(["Secret", saved.secret]);
              if (items.length) setReveal({ title: saved.hook.name, items });
            }}
            onDelete={
              inbound === "new"
                ? undefined
                : async () => {
                    await controller.removeInbound(inbound.id);
                    setInbound(null);
                  }
            }
          />
        </Modal>
      )}
    </section>
  );
}
