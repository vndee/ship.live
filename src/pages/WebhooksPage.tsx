import { useState, type ReactNode } from "react";
import {
  ChevronDown,
  Copy,
  History,
  Inbox,
  Pencil,
  Plus,
  RotateCcw,
  Webhook,
} from "lucide-react";
import type {
  InboundHookView,
  InboundMapping,
  WebhookView,
} from "../../shared/webhook-api";
import type { WebhookFilters } from "../../shared/webhook-filters";
import { WEBHOOK_PRESETS } from "../../shared/webhooks";
import { useWebhooks } from "../hooks/useWebhooks";
import { ago } from "../lib/format";
import { DeliveryLog, DeliveryStatus } from "../components/DeliveryLog";
import { InboundEditor } from "../components/InboundEditor";
import { Modal } from "../components/Modal";
import { eventLabel, WebhookEditor } from "../components/WebhookEditor";
import "../components/webhooks.css";

interface Reveal {
  title: string;
  items: [label: string, value: string][];
}

const FILTER_LABELS: [Exclude<keyof WebhookFilters, "text">, string][] = [
  ["repositories", "Repositories"],
  ["branches", "Branches"],
  ["environments", "Environments"],
  ["services", "Services"],
  ["actors", "People"],
];
const MAPPING_LABELS: [keyof InboundMapping, string][] = [
  ["title", "Title"],
  ["body", "Details"],
  ["url", "Link"],
  ["id", "Delivery ID"],
];

function describeFilters(filters: WebhookFilters): string {
  const parts = FILTER_LABELS.flatMap(([key, label]) =>
    filters[key]?.length ? [`${label}: ${filters[key].join(", ")}`] : [],
  );
  if (filters.text) parts.push(`Summary contains “${filters.text}”`);
  return parts.join(" · ") || "None. Every event of the chosen types is sent.";
}

const minutes = (seconds: number) => `${Math.round(seconds / 60)} min`;
const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

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

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ReceiptStatus({ accepted }: { accepted: boolean }) {
  return (
    <span
      className={`webhook-status-chip ${accepted ? "succeeded" : "failed"}`}
    >
      {accepted ? "Accepted" : "Rejected"}
    </span>
  );
}

/** A collapsible webhook: a one-line summary that opens to its details. */
function WebhookItem({
  id,
  name,
  meta,
  state,
  expanded,
  onToggle,
  children,
}: {
  id: string;
  name: string;
  meta: ReactNode;
  state: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <article className={`webhook-item ${expanded ? "is-expanded" : ""}`}>
      <button
        className="webhook-toggle"
        type="button"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={onToggle}
      >
        <ChevronDown aria-hidden="true" size={16} />
        <span className="webhook-summary">
          <span className="webhook-name">{name}</span>
          <span className="webhook-meta">{meta}</span>
        </span>
        <span className="webhook-state">{state}</span>
      </button>
      {expanded && (
        <div className="webhook-details" id={id}>
          {children}
        </div>
      )}
    </article>
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
  // One item is open at a time, like Service Health's services.
  const [expanded, setExpanded] = useState<string | null>(null);
  const toggle = (key: string) =>
    setExpanded((current) => (current === key ? null : key));
  const now = Date.now();
  const slugs = settings?.inbound.map((hook) => hook.slug) ?? [];
  const presetName = (id: string) =>
    id === "custom"
      ? "Custom"
      : (WEBHOOK_PRESETS[id as keyof typeof WEBHOOK_PRESETS]?.name ?? id);

  async function rotate(hook: InboundHookView) {
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
  }

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
        {settings?.webhooks.map((webhook) => {
          const last = webhook.lastDelivery;
          return (
            <WebhookItem
              key={webhook.id}
              id={`webhook-${webhook.id}`}
              name={webhook.name}
              meta={
                <>
                  {presetName(webhook.preset)} ·{" "}
                  {plural(webhook.events.length, "event")}
                  {webhook.cooldownSeconds
                    ? ` · ${minutes(webhook.cooldownSeconds)} cooldown`
                    : ""}
                </>
              }
              state={
                webhook.pausedReason ? (
                  <span className="webhook-status-chip failed">Paused</span>
                ) : !webhook.enabled ? (
                  <span className="webhook-status-chip skipped">Off</span>
                ) : last ? (
                  <>
                    <DeliveryStatus status={last.status} />
                    <span className="webhook-meta">
                      {ago(last.finishedAt ?? last.createdAt, now)}
                    </span>
                  </>
                ) : (
                  <span className="webhook-meta">No deliveries yet</span>
                )
              }
              expanded={expanded === `out:${webhook.id}`}
              onToggle={() => toggle(`out:${webhook.id}`)}
            >
              {webhook.pausedReason && (
                <p className="webhook-paused">
                  Paused: {webhook.pausedReason} Saving the webhook turns it
                  back on.
                </p>
              )}
              <dl className="webhook-facts">
                <Fact label="Destination">
                  <code>
                    {webhook.method} {webhook.urlHint}
                  </code>
                </Fact>
                <Fact label="Format">
                  {presetName(webhook.preset)} · {webhook.contentType}
                </Fact>
                <Fact label="Signing">
                  {!webhook.hasSecret
                    ? "Unsigned"
                    : webhook.signing === "lark"
                      ? "Lark bot signature"
                      : "HMAC in X-Ship-Signature"}
                </Fact>
                <Fact label="Success check">
                  {webhook.successPath ? (
                    <code>
                      {webhook.successPath} ={" "}
                      {JSON.stringify(webhook.successValue)}
                    </code>
                  ) : (
                    "Any 2xx response"
                  )}
                </Fact>
                <Fact label="Cooldown">
                  {webhook.cooldownSeconds
                    ? `${minutes(webhook.cooldownSeconds)} per alert`
                    : "None"}
                </Fact>
                <Fact label="Custom headers">
                  {webhook.headerNames.join(", ") || "None"}
                </Fact>
                <Fact label="Owner">
                  {webhook.creator.name || "A former member"}
                  <small>Deliveries follow their repository access.</small>
                </Fact>
                <Fact label="Last saved">
                  <time dateTime={webhook.updatedAt}>
                    {new Date(webhook.updatedAt).toLocaleString()}
                  </time>
                </Fact>
              </dl>
              <div className="webhook-detail-block">
                <span className="webhook-detail-label">
                  {plural(webhook.events.length, "event")}
                </span>
                <ul className="webhook-tags">
                  {webhook.events.map((type) => (
                    <li key={type}>{eventLabel(type)}</li>
                  ))}
                </ul>
              </div>
              <div className="webhook-detail-block">
                <span className="webhook-detail-label">Filters</span>
                <p>{describeFilters(webhook.filters)}</p>
              </div>
              <div className="webhook-detail-block">
                <span className="webhook-detail-label">Last delivery</span>
                {last ? (
                  <>
                    <div className="webhook-last">
                      <DeliveryStatus status={last.status} />
                      <span>{last.summary || eventLabel(last.eventType)}</span>
                      <span className="webhook-meta">
                        {last.responseStatus
                          ? `HTTP ${last.responseStatus} · `
                          : ""}
                        {plural(last.attempts, "attempt")} ·{" "}
                        {ago(last.finishedAt ?? last.createdAt, now)}
                      </span>
                    </div>
                    {last.error && (
                      <p className="webhook-error">{last.error}</p>
                    )}
                  </>
                ) : (
                  <p className="webhook-meta">
                    Nothing sent yet. Send a test from Deliveries.
                  </p>
                )}
              </div>
              <div className="webhook-actions">
                <button
                  className="button secondary"
                  onClick={() => setLog(webhook)}
                >
                  <History size={15} /> Deliveries
                </button>
                <button
                  className="button secondary"
                  onClick={() => setEditing(webhook)}
                >
                  <Pencil size={15} /> Edit
                </button>
              </div>
            </WebhookItem>
          );
        })}
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
        to a title, details, and link. Accepted alerts appear in the team&apos;s
        Live activity and can be passed on through your outbound webhooks.
      </p>
      <div className="webhook-list">
        {settings?.inbound.map((hook) => {
          const latest = hook.receipts[0];
          return (
            <WebhookItem
              key={hook.id}
              id={`inbound-${hook.id}`}
              name={hook.name}
              meta={
                <>
                  inbound.{hook.slug}
                  {hook.hasSecret ? " · signed" : ""}
                </>
              }
              state={
                latest ? (
                  <>
                    <ReceiptStatus accepted={latest.accepted} />
                    <span className="webhook-meta">
                      {ago(latest.receivedAt, now)}
                    </span>
                  </>
                ) : (
                  <span className="webhook-meta">Nothing received yet</span>
                )
              }
              expanded={expanded === `in:${hook.id}`}
              onToggle={() => toggle(`in:${hook.id}`)}
            >
              <dl className="webhook-facts">
                <Fact label="Event">
                  <code>inbound.{hook.slug}</code>
                </Fact>
                <Fact label="Signature">
                  {hook.hasSecret
                    ? "Required: X-Signature-256"
                    : "Not required"}
                </Fact>
                <Fact label="Created">
                  <time dateTime={hook.createdAt}>
                    {new Date(hook.createdAt).toLocaleString()}
                  </time>
                  {hook.creator.name && <small>by {hook.creator.name}</small>}
                </Fact>
                <Fact label="Last received">
                  {hook.lastReceivedAt ? (
                    <time dateTime={hook.lastReceivedAt}>
                      {new Date(hook.lastReceivedAt).toLocaleString()}
                    </time>
                  ) : (
                    "Never"
                  )}
                </Fact>
              </dl>
              <div className="webhook-detail-block">
                <span className="webhook-detail-label">Mapping</span>
                <dl className="webhook-mapping">
                  {MAPPING_LABELS.map(([key, label]) => (
                    <div key={key}>
                      <dt>{label}</dt>
                      <dd>
                        {hook.mapping[key] ? (
                          <code>{hook.mapping[key]}</code>
                        ) : (
                          <span className="webhook-meta">Not mapped</span>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
              <div className="webhook-detail-block">
                <span className="webhook-detail-label">Recent requests</span>
                {hook.receipts.length ? (
                  <ul className="inbound-receipts">
                    {hook.receipts.map((receipt) => (
                      <li key={receipt.id}>
                        <ReceiptStatus accepted={receipt.accepted} />
                        <span>{receipt.summary ?? receipt.error}</span>
                        <span className="webhook-meta">
                          {ago(receipt.receivedAt, now)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="webhook-meta">
                    No requests yet. Send JSON to the endpoint URL shown when it
                    was created, or issue a new one.
                  </p>
                )}
              </div>
              <div className="webhook-actions">
                <button
                  className="button secondary"
                  onClick={() => rotate(hook)}
                >
                  <RotateCcw size={15} /> New URL
                </button>
                <button
                  className="button secondary"
                  onClick={() => setInbound(hook)}
                >
                  <Pencil size={15} /> Edit
                </button>
              </div>
            </WebhookItem>
          );
        })}
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
