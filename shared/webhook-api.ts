import type { WebhookFilters } from "./webhook-filters";
import type { WebhookPresetId } from "./webhooks";

export type WebhookMethod = "POST" | "PUT" | "PATCH";
export type WebhookContentType =
  "application/json" | "text/plain" | "application/x-www-form-urlencoded";
export type WebhookSigning = "ship" | "lark";

/** What the editor sends. Secret fields left out keep their saved values. */
export interface WebhookInput {
  name: string;
  preset: WebhookPresetId | "custom";
  /** Required to create; left out to keep the saved URL. */
  url?: string;
  method: WebhookMethod;
  contentType: WebhookContentType;
  template: string;
  /** Left out to keep saved headers; {} removes them. */
  headers?: Record<string, string>;
  /**
   * Left out to keep the saved secret, "" to remove it, or "generate" for a
   * new random secret that the response shows once.
   */
  secret?: string;
  signing: WebhookSigning;
  /** A response JSON path that must equal successValue; "" for none. */
  successPath: string;
  successValue: string | number | boolean | null;
  events: string[];
  filters: WebhookFilters;
  cooldownSeconds: number;
  enabled: boolean;
}

export type WebhookDeliveryStatus =
  "pending" | "succeeded" | "failed" | "dead" | "skipped";

export interface WebhookDeliveryView {
  id: string;
  eventId: string;
  eventType: string;
  summary: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  requestBody: string | null;
  responseStatus: number | null;
  responseBody: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  nextAttemptAt: string | null;
}

/** An endpoint as the team sees it. URLs, header values, and secrets stay sealed. */
export interface WebhookView extends Omit<
  WebhookInput,
  "url" | "headers" | "secret"
> {
  id: string;
  urlHint: string;
  headerNames: string[];
  hasSecret: boolean;
  pausedReason: string | null;
  creator: { id: string; name: string };
  createdAt: string;
  updatedAt: string;
  lastDelivery: WebhookDeliveryView | null;
}

export interface SavedWebhook {
  webhook: WebhookView;
  /** Present once, right after "generate". */
  secret?: string;
}

export interface WebhookTestResult {
  ok: boolean;
  status: number | null;
  body: string;
  error?: string;
  latencyMs: number;
  requestBody: string;
}

/**
 * Inbound fields are text templates rendered against { payload }, such as
 * "{{payload.alerts.0.labels.alertname}} is {{payload.status}}".
 */
export interface InboundMapping {
  title: string;
  body: string;
  url: string;
  /** Deduplicates retries from the sender; "" accepts every request. */
  id: string;
}

export interface InboundHookInput {
  name: string;
  slug: string;
  mapping: InboundMapping;
  /** "generate" for an HMAC secret shown once, "" for none, left out to keep. */
  secret?: string;
}

export interface InboundReceiptView {
  id: string;
  receivedAt: string;
  accepted: boolean;
  summary: string | null;
  error: string | null;
}

export interface InboundHookView {
  id: string;
  name: string;
  slug: string;
  mapping: InboundMapping;
  hasSecret: boolean;
  creator: { id: string; name: string };
  createdAt: string;
  lastReceivedAt: string | null;
  receipts: InboundReceiptView[];
}

export interface SavedInboundHook {
  hook: InboundHookView;
  /** The endpoint URL with its token, present once on creation or rotation. */
  endpoint?: string;
  secret?: string;
}

export interface WebhookSettings {
  webhooks: WebhookView[];
  inbound: InboundHookView[];
  /** False when TOKEN_ENCRYPTION_KEY is missing, so nothing can be saved. */
  configured: boolean;
}
