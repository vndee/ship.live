import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { AuthError } from "./auth.js";
import { validateHeaders } from "./health-probe.js";
import { parseJsonPath } from "./json-path.js";
import { publicHttpUrl } from "./outbound.js";
import { SecretBox } from "./secret-box.js";
import {
  compileTemplate,
  TemplateError,
  type TemplateMode,
} from "../shared/webhook-template.js";
import {
  FilterError,
  validateFilters,
  type WebhookFilters,
} from "../shared/webhook-filters.js";
import {
  sampleEvent,
  WEBHOOK_EVENT_GROUPS,
  WEBHOOK_EVENT_LABELS,
  WEBHOOK_PRESETS,
  type WebhookEventType,
} from "../shared/webhooks.js";
import type {
  InboundHookView,
  InboundMapping,
  InboundReceiptView,
  SavedInboundHook,
  SavedWebhook,
  WebhookContentType,
  WebhookDeliveryStatus,
  WebhookDeliveryView,
  WebhookMethod,
  WebhookSigning,
  WebhookView,
} from "../shared/webhook-api.js";

const MAX_WEBHOOKS = 20;
const MAX_INBOUND = 10;
const METHODS: readonly WebhookMethod[] = ["POST", "PUT", "PATCH"];
const CONTENT_TYPES: readonly WebhookContentType[] = [
  "application/json",
  "text/plain",
  "application/x-www-form-urlencoded",
];
const SUBSCRIBABLE = new Set<string>(
  WEBHOOK_EVENT_GROUPS.flatMap((group) => group.types),
);
const INBOUND_TYPE = /^inbound\.[a-z0-9][a-z0-9-]{0,39}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
// ship.live sets these itself; X-Ship-* carries the event and signature.
const RESERVED_HEADERS = new Set(["content-type", "user-agent"]);

/** Delivery values used to check a template before any real delivery. */
export const SAMPLE_DELIVERY = {
  id: "sample",
  attempt: 1,
  timestamp: "1789027509",
  larkSign: "c2FtcGxlLXNpZ24=",
};

export const templateMode = (contentType: WebhookContentType): TemplateMode =>
  contentType === "application/json" ? "json" : "text";

const bad = (message: string): never => {
  throw new AuthError(400, message);
};
const missing = () => new AuthError(404, "Webhook not found.");
const validId = (id: string) =>
  /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id);
function hasControl(value: string) {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  });
}
function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return (
    value instanceof Date ? value : new Date(String(value))
  ).toISOString();
}
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

/** Shows where a webhook points without revealing tokens in its path. */
export function urlHint(url: string): string {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  const path =
    segments.length > 1 ? `/${segments[0]}/…` : segments.length ? "/…" : "";
  return `${parsed.protocol}//${parsed.host}${path}`;
}

function name(value: unknown, noun: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed.length > 80 || hasControl(trimmed))
    bad(`Name the ${noun} in 1–80 characters.`);
  return trimmed;
}

/** undefined keeps the saved secret, "" removes it, "generate" makes one. */
function secretInput(value: unknown): string | undefined {
  if (value === undefined || value === "" || value === "generate") return value;
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 512 ||
    hasControl(value)
  )
    bad("A secret must be 8–512 characters.");
  return value as string;
}

interface ValidWebhook {
  name: string;
  preset: string;
  url?: string;
  method: WebhookMethod;
  contentType: WebhookContentType;
  template: string;
  headers?: Record<string, string>;
  secret?: string;
  signing: WebhookSigning;
  successPath: string | null;
  successValue: string | number | boolean | null;
  events: string[];
  filters: WebhookFilters;
  cooldownSeconds: number;
  enabled: boolean;
}

export function validateWebhook(
  input: unknown,
  creating: boolean,
): ValidWebhook {
  if (!input || typeof input !== "object" || Array.isArray(input))
    bad("Invalid webhook.");
  const data = input as Record<string, unknown>;
  const preset = data.preset;
  if (
    preset !== "custom" &&
    !(typeof preset === "string" && Object.hasOwn(WEBHOOK_PRESETS, preset))
  )
    bad("Choose a preset or Custom.");
  let url: string | undefined;
  if (data.url !== undefined) {
    const parsed = publicHttpUrl(data.url);
    if (!parsed)
      bad("Use a public HTTP or HTTPS URL without credentials or a fragment.");
    url = parsed!.href;
  } else if (creating) bad("Enter the webhook URL.");
  const method = data.method ?? "POST";
  if (!METHODS.includes(method as WebhookMethod))
    bad("Use POST, PUT, or PATCH.");
  const contentType = data.contentType ?? "application/json";
  if (!CONTENT_TYPES.includes(contentType as WebhookContentType))
    bad("Choose a supported content type.");
  const template = data.template;
  if (typeof template !== "string" || !template.trim())
    bad("Write a body template.");
  let compiled!: ReturnType<typeof compileTemplate>;
  try {
    compiled = compileTemplate(
      template as string,
      templateMode(contentType as WebhookContentType),
    );
  } catch (error) {
    bad(error instanceof TemplateError ? error.message : "Invalid template.");
  }
  const events = data.events;
  if (
    !Array.isArray(events) ||
    !events.length ||
    events.length > 30 ||
    !events.every(
      (type) =>
        typeof type === "string" &&
        (SUBSCRIBABLE.has(type) || INBOUND_TYPE.test(type)),
    )
  )
    bad("Choose at least one known event.");
  const unique = [...new Set(events as string[])];
  // Render every subscribed event's sample now, so a template that breaks for
  // one event type fails here rather than at delivery time.
  for (const type of unique)
    try {
      compiled.render(sampleEvent(type), { delivery: SAMPLE_DELIVERY });
    } catch (error) {
      const label =
        WEBHOOK_EVENT_LABELS[type as WebhookEventType] ?? "Inbound webhook";
      bad(
        `${label}: ${error instanceof TemplateError ? error.message : "the template could not render."}`,
      );
    }
  let filters: WebhookFilters = {};
  try {
    filters = validateFilters(data.filters);
  } catch (error) {
    bad(error instanceof FilterError ? error.message : "Invalid filters.");
  }
  let headers: Record<string, string> | undefined;
  if (data.headers !== undefined) {
    headers = validateHeaders(data.headers);
    if (
      Object.keys(headers).some(
        (header) =>
          RESERVED_HEADERS.has(header) || header.startsWith("x-ship-"),
      )
    )
      bad(
        "Content-Type, User-Agent, and X-Ship-* headers are set by ship.live.",
      );
  }
  const signing = data.signing ?? "ship";
  if (signing !== "ship" && signing !== "lark")
    bad("Choose ship.live or Lark signing.");
  const successPath =
    typeof data.successPath === "string" && data.successPath.trim()
      ? data.successPath.trim()
      : null;
  if (data.successPath !== undefined && typeof data.successPath !== "string")
    bad("Use a supported JSON path for the success check.");
  if (successPath)
    try {
      parseJsonPath(successPath);
    } catch {
      bad("Use a supported JSON path for the success check.");
    }
  const successValue = data.successValue ?? null;
  if (
    successValue !== null &&
    !(typeof successValue === "string" && successValue.length <= 200) &&
    !(typeof successValue === "number" && Number.isFinite(successValue)) &&
    typeof successValue !== "boolean"
  )
    bad("The success value must be a short string, number, true, or false.");
  const cooldownSeconds = data.cooldownSeconds ?? 0;
  if (
    typeof cooldownSeconds !== "number" ||
    !Number.isInteger(cooldownSeconds) ||
    cooldownSeconds < 0 ||
    cooldownSeconds > 86_400
  )
    bad("The cooldown must be 0–86400 seconds.");
  if (data.enabled !== undefined && typeof data.enabled !== "boolean")
    bad("Invalid enabled state.");
  return {
    name: name(data.name, "webhook"),
    preset: preset as string,
    url,
    method: method as WebhookMethod,
    contentType: contentType as WebhookContentType,
    template: template as string,
    headers,
    secret: secretInput(data.secret),
    signing: signing as WebhookSigning,
    successPath,
    successValue: successPath
      ? (successValue as string | number | boolean | null)
      : null,
    events: unique,
    filters,
    cooldownSeconds: cooldownSeconds as number,
    enabled: data.enabled === undefined ? true : (data.enabled as boolean),
  };
}

function validateMapping(input: unknown): InboundMapping {
  if (!input || typeof input !== "object" || Array.isArray(input))
    bad("Map the inbound payload to a title.");
  const data = input as Record<string, unknown>;
  const limits: Record<keyof InboundMapping, number> = {
    title: 2000,
    body: 4000,
    url: 2000,
    id: 500,
  };
  const mapping = {} as InboundMapping;
  for (const key of Object.keys(limits) as (keyof InboundMapping)[]) {
    const value = data[key] ?? "";
    if (typeof value !== "string" || value.length > limits[key])
      bad(`The ${key} template must be at most ${limits[key]} characters.`);
    try {
      compileTemplate(value as string, "text");
    } catch (error) {
      bad(
        `${key}: ${error instanceof TemplateError ? error.message : "invalid template."}`,
      );
    }
    mapping[key] = value as string;
  }
  if (!mapping.title.trim()) bad("Map the inbound payload to a title.");
  return mapping;
}

export interface WebhookRow {
  id: string;
  workspace_id: string;
  creator_user_id: string;
  name: string;
  preset: string;
  url_encrypted: string;
  url_hint: string;
  method: WebhookMethod;
  content_type: WebhookContentType;
  template: string;
  headers_encrypted: string | null;
  secret_encrypted: string | null;
  signing: WebhookSigning;
  success_json_path: string | null;
  success_json_value: string | number | boolean | null;
  events: string[];
  filters: WebhookFilters;
  cooldown_seconds: number;
  repository_ids: string[];
  enabled: boolean;
  paused_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

/** A webhook with its sealed fields opened, for delivery. */
export interface WebhookTarget {
  id: string;
  workspaceId: string;
  creatorUserId: string;
  name: string;
  url: string;
  method: WebhookMethod;
  contentType: WebhookContentType;
  template: string;
  headers: Record<string, string>;
  secret?: string;
  signing: WebhookSigning;
  successPath: string | null;
  successValue: string | number | boolean | null;
  events: string[];
  filters: WebhookFilters;
  cooldownSeconds: number;
  repositoryIds: number[];
  enabled: boolean;
}

interface DeliveryJson {
  id: string;
  event_id: string;
  event_type: string;
  summary: string | null;
  status: WebhookDeliveryStatus;
  attempts: number;
  request_body: string | null;
  response_status: number | null;
  response_body: string | null;
  error: string | null;
  created_at: string | Date;
  finished_at: string | Date | null;
  next_attempt_at: string | Date | null;
}

const DELIVERY_COLUMNS = `d.id, d.event_id, e.type AS event_type, e.payload->>'summary' AS summary,
  d.status, d.attempts, d.request_body, d.response_status, d.response_body, d.error,
  d.created_at, d.finished_at, CASE WHEN d.status = 'pending' THEN d.next_attempt_at END AS next_attempt_at`;

function deliveryView(row: DeliveryJson): WebhookDeliveryView {
  return {
    id: row.id,
    eventId: row.event_id,
    eventType: row.event_type,
    summary: row.summary ?? "",
    status: row.status,
    attempts: row.attempts,
    requestBody: row.request_body,
    responseStatus: row.response_status,
    responseBody: row.response_body,
    error: row.error,
    createdAt: iso(row.created_at)!,
    finishedAt: iso(row.finished_at),
    nextAttemptAt: iso(row.next_attempt_at),
  };
}

interface InboundRow {
  id: string;
  workspace_id: string;
  creator_user_id: string;
  creator_name: string | null;
  name: string;
  slug: string;
  secret_encrypted: string | null;
  mapping: InboundMapping;
  created_at: Date;
  last_received_at: Date | null;
}

export interface InboundTarget {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  mapping: InboundMapping;
  secret?: string;
}

export class WebhookStore {
  constructor(
    readonly pool: Pool,
    private readonly box = new SecretBox(),
  ) {}

  get configured(): boolean {
    return this.box.configured;
  }

  private requireKey() {
    if (!this.box.configured)
      throw new AuthError(
        503,
        "Webhooks need TOKEN_ENCRYPTION_KEY to store URLs and secrets.",
      );
  }

  /** Opens a row's sealed URL, headers, and secret. */
  target(row: WebhookRow): WebhookTarget {
    const open = (value: string, field: string) =>
      this.box.open(value, `webhook:${row.id}:${field}`);
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      creatorUserId: row.creator_user_id,
      name: row.name,
      url: open(row.url_encrypted, "url"),
      method: row.method,
      contentType: row.content_type,
      template: row.template,
      headers: row.headers_encrypted
        ? (JSON.parse(open(row.headers_encrypted, "headers")) as Record<
            string,
            string
          >)
        : {},
      secret: row.secret_encrypted
        ? open(row.secret_encrypted, "secret")
        : undefined,
      signing: row.signing,
      successPath: row.success_json_path,
      successValue: row.success_json_value,
      events: row.events,
      filters: row.filters,
      cooldownSeconds: row.cooldown_seconds,
      repositoryIds: row.repository_ids.map(Number),
      enabled: row.enabled,
    };
  }

  async targetById(workspaceId: string, id: string): Promise<WebhookTarget> {
    if (!validId(id)) throw missing();
    const { rows } = await this.pool.query<WebhookRow>(
      "SELECT * FROM ship_live_webhooks WHERE workspace_id=$1 AND id=$2",
      [workspaceId, id],
    );
    if (!rows[0]) throw missing();
    return this.target(rows[0]);
  }

  private headerNames(row: WebhookRow): string[] {
    if (!row.headers_encrypted) return [];
    try {
      return Object.keys(
        JSON.parse(
          this.box.open(row.headers_encrypted, `webhook:${row.id}:headers`),
        ),
      ).sort();
    } catch {
      return [];
    }
  }

  private view(
    row: WebhookRow & {
      creator_name: string | null;
      last_delivery: DeliveryJson | null;
    },
  ): WebhookView {
    return {
      id: row.id,
      name: row.name,
      preset: row.preset as WebhookView["preset"],
      urlHint: row.url_hint,
      method: row.method,
      contentType: row.content_type,
      template: row.template,
      headerNames: this.headerNames(row),
      hasSecret: Boolean(row.secret_encrypted),
      signing: row.signing,
      successPath: row.success_json_path ?? "",
      successValue: row.success_json_value,
      events: row.events,
      filters: row.filters,
      cooldownSeconds: row.cooldown_seconds,
      enabled: row.enabled,
      pausedReason: row.paused_reason,
      creator: { id: row.creator_user_id, name: row.creator_name ?? "" },
      createdAt: iso(row.created_at)!,
      updatedAt: iso(row.updated_at)!,
      lastDelivery: row.last_delivery ? deliveryView(row.last_delivery) : null,
    };
  }

  private async webhookViews(
    workspaceId: string,
    id?: string,
  ): Promise<WebhookView[]> {
    const { rows } = await this.pool.query<
      WebhookRow & {
        creator_name: string | null;
        last_delivery: DeliveryJson | null;
      }
    >(
      `SELECT h.*, u.name AS creator_name,
         (SELECT to_jsonb(latest) FROM (
            SELECT ${DELIVERY_COLUMNS}
            FROM ship_live_webhook_deliveries d
            JOIN ship_live_webhook_events e ON e.id = d.event_id
            WHERE d.webhook_id = h.id
            ORDER BY coalesce(d.finished_at, d.created_at) DESC, d.id LIMIT 1) latest) AS last_delivery
       FROM ship_live_webhooks h
       LEFT JOIN ship_live_auth_users u ON u.id = h.creator_user_id
       WHERE h.workspace_id = $1 AND ($2::uuid IS NULL OR h.id = $2)
       ORDER BY h.created_at, h.id`,
      [workspaceId, id ?? null],
    );
    return rows.map((row) => this.view(row));
  }

  async settings(workspaceId: string): Promise<{
    webhooks: WebhookView[];
    inbound: InboundHookView[];
  }> {
    return {
      webhooks: await this.webhookViews(workspaceId),
      inbound: await this.inboundViews(workspaceId),
    };
  }

  private async one(workspaceId: string, id: string): Promise<WebhookView> {
    const [view] = await this.webhookViews(workspaceId, id);
    if (!view) throw missing();
    return view;
  }

  private seal(id: string, field: string, value: string) {
    return this.box.seal(value, `webhook:${id}:${field}`);
  }

  async create(
    workspaceId: string,
    userId: string,
    input: unknown,
    repositoryIds: number[],
  ): Promise<SavedWebhook> {
    this.requireKey();
    const valid = validateWebhook(input, true);
    const { rows } = await this.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM ship_live_webhooks WHERE workspace_id=$1",
      [workspaceId],
    );
    if (rows[0].count >= MAX_WEBHOOKS)
      bad(`A workspace can have at most ${MAX_WEBHOOKS} webhooks.`);
    const id = randomUUID();
    const secret =
      valid.secret === "generate"
        ? randomBytes(32).toString("base64url")
        : valid.secret || undefined;
    await this.pool.query(
      `INSERT INTO ship_live_webhooks (id, workspace_id, creator_user_id, name, preset,
         url_encrypted, url_hint, method, content_type, template, headers_encrypted,
         secret_encrypted, signing, success_json_path, success_json_value, events,
         filters, cooldown_seconds, repository_ids, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        id,
        workspaceId,
        userId,
        valid.name,
        valid.preset,
        this.seal(id, "url", valid.url!),
        urlHint(valid.url!),
        valid.method,
        valid.contentType,
        valid.template,
        valid.headers && Object.keys(valid.headers).length
          ? this.seal(id, "headers", JSON.stringify(valid.headers))
          : null,
        secret ? this.seal(id, "secret", secret) : null,
        valid.signing,
        valid.successPath,
        valid.successPath ? JSON.stringify(valid.successValue) : null,
        valid.events,
        JSON.stringify(valid.filters),
        valid.cooldownSeconds,
        repositoryIds,
        valid.enabled,
      ],
    );
    return {
      webhook: await this.one(workspaceId, id),
      ...(valid.secret === "generate" ? { secret } : {}),
    };
  }

  /**
   * Saving makes the editor the webhook's owner: its repositories become the
   * editor's current ones, and deliveries follow the editor's access.
   */
  async update(
    workspaceId: string,
    id: string,
    userId: string,
    input: unknown,
    repositoryIds: number[],
  ): Promise<SavedWebhook> {
    this.requireKey();
    if (!validId(id)) throw missing();
    const valid = validateWebhook(input, false);
    const secret =
      valid.secret === "generate"
        ? randomBytes(32).toString("base64url")
        : valid.secret;
    const { rowCount } = await this.pool.query(
      `UPDATE ship_live_webhooks SET creator_user_id=$3, name=$4, preset=$5,
         url_encrypted=coalesce($6, url_encrypted), url_hint=coalesce($7, url_hint),
         method=$8, content_type=$9, template=$10,
         headers_encrypted=CASE WHEN $11::boolean THEN $12 ELSE headers_encrypted END,
         secret_encrypted=CASE WHEN $13::boolean THEN $14 ELSE secret_encrypted END,
         signing=$15, success_json_path=$16, success_json_value=$17, events=$18,
         filters=$19, cooldown_seconds=$20, repository_ids=$21, enabled=$22,
         paused_reason=CASE WHEN $22 THEN NULL ELSE paused_reason END, updated_at=now()
       WHERE workspace_id=$1 AND id=$2`,
      [
        workspaceId,
        id,
        userId,
        valid.name,
        valid.preset,
        valid.url ? this.seal(id, "url", valid.url) : null,
        valid.url ? urlHint(valid.url) : null,
        valid.method,
        valid.contentType,
        valid.template,
        valid.headers !== undefined,
        valid.headers && Object.keys(valid.headers).length
          ? this.seal(id, "headers", JSON.stringify(valid.headers))
          : null,
        secret !== undefined,
        secret ? this.seal(id, "secret", secret) : null,
        valid.signing,
        valid.successPath,
        valid.successPath ? JSON.stringify(valid.successValue) : null,
        valid.events,
        JSON.stringify(valid.filters),
        valid.cooldownSeconds,
        repositoryIds,
        valid.enabled,
      ],
    );
    if (!rowCount) throw missing();
    return {
      webhook: await this.one(workspaceId, id),
      ...(valid.secret === "generate" ? { secret } : {}),
    };
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    if (!validId(id)) throw missing();
    const { rowCount } = await this.pool.query(
      "DELETE FROM ship_live_webhooks WHERE workspace_id=$1 AND id=$2",
      [workspaceId, id],
    );
    if (!rowCount) throw missing();
  }

  async deliveries(
    workspaceId: string,
    webhookId: string,
    limit = 50,
  ): Promise<WebhookDeliveryView[]> {
    if (!validId(webhookId)) throw missing();
    const { rows } = await this.pool.query<DeliveryJson>(
      `SELECT ${DELIVERY_COLUMNS}
       FROM ship_live_webhook_deliveries d
       JOIN ship_live_webhook_events e ON e.id = d.event_id
       JOIN ship_live_webhooks h ON h.id = d.webhook_id
       WHERE h.workspace_id = $1 AND h.id = $2
       ORDER BY d.created_at DESC, d.id LIMIT $3`,
      [workspaceId, webhookId, Math.min(Math.max(1, limit), 100)],
    );
    return rows.map(deliveryView);
  }

  /** Queues a finished delivery again, with a fresh set of retries. */
  async redeliver(
    workspaceId: string,
    webhookId: string,
    deliveryId: string,
  ): Promise<void> {
    if (!validId(webhookId) || !validId(deliveryId)) throw missing();
    const { rowCount } = await this.pool.query(
      `UPDATE ship_live_webhook_deliveries d SET status='pending', attempts=0,
         next_attempt_at=now(), finished_at=NULL, error=NULL, lease=NULL, lease_until=NULL
       FROM ship_live_webhooks h
       WHERE d.id=$3 AND d.webhook_id=$2 AND h.id=d.webhook_id AND h.workspace_id=$1
         AND d.status <> 'pending'`,
      [workspaceId, webhookId, deliveryId],
    );
    if (!rowCount)
      throw new AuthError(404, "Delivery not found or still pending.");
  }

  private async inboundViews(
    workspaceId: string,
    id?: string,
  ): Promise<InboundHookView[]> {
    const { rows } = await this.pool.query<InboundRow>(
      `SELECT i.*, u.name AS creator_name FROM ship_live_inbound_hooks i
       LEFT JOIN ship_live_auth_users u ON u.id = i.creator_user_id
       WHERE i.workspace_id=$1 AND ($2::uuid IS NULL OR i.id=$2)
       ORDER BY i.created_at, i.id`,
      [workspaceId, id ?? null],
    );
    const receipts = await this.pool.query<
      InboundReceiptView & { hook_id: string }
    >(
      `SELECT hook_id, id, received_at AS "receivedAt", accepted, summary, error FROM (
         SELECT r.*, row_number() OVER (PARTITION BY r.hook_id ORDER BY r.received_at DESC, r.id) AS position
         FROM ship_live_inbound_receipts r WHERE r.hook_id = ANY($1::uuid[])
       ) recent WHERE position <= 10 ORDER BY received_at DESC`,
      [rows.map((row) => row.id)],
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      mapping: row.mapping,
      hasSecret: Boolean(row.secret_encrypted),
      creator: { id: row.creator_user_id, name: row.creator_name ?? "" },
      createdAt: iso(row.created_at)!,
      lastReceivedAt: iso(row.last_received_at),
      receipts: receipts.rows
        .filter((receipt) => receipt.hook_id === row.id)
        .map(({ hook_id: _hook, ...receipt }) => ({
          ...receipt,
          receivedAt: iso(receipt.receivedAt)!,
        })),
    }));
  }

  private async inboundView(
    workspaceId: string,
    id: string,
  ): Promise<InboundHookView> {
    const [view] = await this.inboundViews(workspaceId, id);
    if (!view) throw new AuthError(404, "Inbound webhook not found.");
    return view;
  }

  /** The endpoint carries a random token; only its hash is stored. */
  async createInbound(
    workspaceId: string,
    userId: string,
    input: unknown,
  ): Promise<SavedInboundHook> {
    this.requireKey();
    const data = (input ?? {}) as Record<string, unknown>;
    const slug = typeof data.slug === "string" ? data.slug : "";
    if (!SLUG.test(slug))
      bad("Use a slug of lowercase letters, digits, and hyphens (up to 40).");
    const mapping = validateMapping(data.mapping);
    const secretChoice = secretInput(data.secret);
    const { rows } = await this.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM ship_live_inbound_hooks WHERE workspace_id=$1",
      [workspaceId],
    );
    if (rows[0].count >= MAX_INBOUND)
      bad(`A workspace can have at most ${MAX_INBOUND} inbound webhooks.`);
    const id = randomUUID();
    const token = randomBytes(24).toString("base64url");
    const secret =
      secretChoice === "generate"
        ? randomBytes(32).toString("base64url")
        : secretChoice || undefined;
    try {
      await this.pool.query(
        `INSERT INTO ship_live_inbound_hooks (id, workspace_id, creator_user_id, name, slug,
           token_hash, secret_encrypted, mapping) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          workspaceId,
          userId,
          name(data.name, "inbound webhook"),
          slug,
          hash(token),
          secret ? this.box.seal(secret, `inbound:${id}:secret`) : null,
          JSON.stringify(mapping),
        ],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        bad("Another inbound webhook in this workspace uses that slug.");
      throw error;
    }
    return {
      hook: await this.inboundView(workspaceId, id),
      endpoint: `/api/hooks/${token}`,
      ...(secretChoice === "generate" ? { secret } : {}),
    };
  }

  async updateInbound(
    workspaceId: string,
    id: string,
    input: unknown,
  ): Promise<SavedInboundHook> {
    this.requireKey();
    if (!validId(id)) throw new AuthError(404, "Inbound webhook not found.");
    const data = (input ?? {}) as Record<string, unknown>;
    const mapping = validateMapping(data.mapping);
    const secretChoice = secretInput(data.secret);
    const secret =
      secretChoice === "generate"
        ? randomBytes(32).toString("base64url")
        : secretChoice;
    const { rowCount } = await this.pool.query(
      `UPDATE ship_live_inbound_hooks SET name=$3, mapping=$4,
         secret_encrypted=CASE WHEN $5::boolean THEN $6 ELSE secret_encrypted END
       WHERE workspace_id=$1 AND id=$2`,
      [
        workspaceId,
        id,
        name(data.name, "inbound webhook"),
        JSON.stringify(mapping),
        secret !== undefined,
        secret ? this.box.seal(secret, `inbound:${id}:secret`) : null,
      ],
    );
    if (!rowCount) throw new AuthError(404, "Inbound webhook not found.");
    return {
      hook: await this.inboundView(workspaceId, id),
      ...(secretChoice === "generate" ? { secret } : {}),
    };
  }

  /** Issues a new endpoint URL; the previous one stops working at once. */
  async rotateInbound(
    workspaceId: string,
    id: string,
  ): Promise<SavedInboundHook> {
    if (!validId(id)) throw new AuthError(404, "Inbound webhook not found.");
    const token = randomBytes(24).toString("base64url");
    const { rowCount } = await this.pool.query(
      "UPDATE ship_live_inbound_hooks SET token_hash=$3 WHERE workspace_id=$1 AND id=$2",
      [workspaceId, id, hash(token)],
    );
    if (!rowCount) throw new AuthError(404, "Inbound webhook not found.");
    return {
      hook: await this.inboundView(workspaceId, id),
      endpoint: `/api/hooks/${token}`,
    };
  }

  async removeInbound(workspaceId: string, id: string): Promise<void> {
    if (!validId(id)) throw new AuthError(404, "Inbound webhook not found.");
    const { rowCount } = await this.pool.query(
      "DELETE FROM ship_live_inbound_hooks WHERE workspace_id=$1 AND id=$2",
      [workspaceId, id],
    );
    if (!rowCount) throw new AuthError(404, "Inbound webhook not found.");
  }

  async inboundByToken(token: string): Promise<InboundTarget | undefined> {
    if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return undefined;
    const { rows } = await this.pool.query<InboundRow>(
      "SELECT *, NULL AS creator_name FROM ship_live_inbound_hooks WHERE token_hash=$1",
      [hash(token)],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      slug: row.slug,
      mapping: row.mapping,
      secret: row.secret_encrypted
        ? this.box.open(row.secret_encrypted, `inbound:${row.id}:secret`)
        : undefined,
    };
  }

  /** Keeps the latest 50 receipts per endpoint for its log. */
  async receipt(
    hookId: string,
    accepted: boolean,
    summary: string | null,
    error: string | null,
  ): Promise<void> {
    await this.pool.query(
      `WITH added AS (
         INSERT INTO ship_live_inbound_receipts (id, hook_id, accepted, summary, error)
         VALUES ($1,$2,$3,$4,$5)
       ), touched AS (
         UPDATE ship_live_inbound_hooks SET last_received_at=now() WHERE id=$2
       )
       DELETE FROM ship_live_inbound_receipts WHERE id IN (
         SELECT id FROM ship_live_inbound_receipts WHERE hook_id=$2
         ORDER BY received_at DESC, id OFFSET 49)`,
      [randomUUID(), hookId, accepted, summary?.slice(0, 500) ?? null, error],
    );
  }
}
