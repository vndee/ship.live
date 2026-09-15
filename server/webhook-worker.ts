import type { Pool } from "pg";
import { createHash } from "node:crypto";
import { compileTemplate, TemplateError } from "../shared/webhook-template.js";
import {
  WEBHOOK_PRESETS,
  type WebhookEvent,
  type WebhookPresetId,
} from "../shared/webhooks.js";
import { parseJsonPath, readJsonPath } from "./json-path.js";
import { log } from "./logger.js";
import { metrics } from "./metrics.js";
import {
  sendOutbound,
  type OutboundRequest,
  type OutboundResponse,
} from "./outbound.js";
import {
  claimDeliveries,
  completeDelivery,
  routeEvents,
  type AccessCheck,
  type ClaimedDelivery,
  type DeliveryOutcome,
  ownerMaySee,
} from "./webhook-outbox.js";
import { larkSignature, shipSignature } from "./webhook-signing.js";
import {
  scheduleDigests,
  prepareDigest,
  type PreparedDigest,
} from "./digest.js";
import {
  templateMode,
  type WebhookStore,
  type WebhookTarget,
} from "./webhook-store.js";

/** Waits between attempts: 1 and 5 minutes, then 30 minutes, 2 hours, and 6 hours. */
export const RETRY_SECONDS = [60, 300, 1800, 7200, 21_600];
export const MAX_ATTEMPTS = RETRY_SECONDS.length + 1;

const deliveries = metrics.counter(
  "ship_live_webhook_deliveries_total",
  "Webhook delivery attempts by outcome.",
  ["outcome"],
);

// Exact SHA-256 fingerprints of the original built-in chat templates. Only
// unchanged defaults receive digest improvements; custom bytes stay untouched.
const legacyDigestPresets: Record<string, WebhookPresetId> = {
  "3997e00d51067cd160dec12479c7971e05cd9169e48b4917ae5eccf7c5227b5f": "slack",
  d2165d282b0a164a0c2b4da007644bdcdd3c8e02c2d39edfb65320aabd9ebbcd: "discord",
  "9c839a8b2b58e7c4df7c6a997c79c5b9142ebba0d5078a52723f55e185371054": "teams",
  a742a7535d193b5f8c4a087bd7f2d910661666122fe49abd7011bffc356def18:
    "google-chat",
  "0e0d20be5352e79eeff9ade7c886af16dfedb0bb1c06d3b077b79bd5ff254017": "lark",
};

export type Send = (request: OutboundRequest) => Promise<OutboundResponse>;

/**
 * Renders and signs one delivery. Lark signing puts timestamp and sign in the
 * body through {{@delivery.*}}; ship.live signing adds X-Ship-Signature over
 * "<timestamp>.<body>". Throws TemplateError if the template stops rendering.
 */
export function prepareRequest(
  target: WebhookTarget,
  event: WebhookEvent,
  delivery: { id: string; attempt: number },
  now = Date.now(),
): OutboundRequest {
  const timestamp = Math.floor(now / 1000);
  const larkSign =
    target.signing === "lark" && target.secret
      ? larkSignature(target.secret, timestamp)
      : undefined;
  const legacyPreset =
    event.type === "digest.weekly" && target.contentType === "application/json"
      ? legacyDigestPresets[
          createHash("sha256").update(target.template).digest("hex")
        ]
      : undefined;
  const body = compileTemplate(
    legacyPreset ? WEBHOOK_PRESETS[legacyPreset].template : target.template,
    templateMode(target.contentType),
  ).render(event, {
    delivery: {
      id: delivery.id,
      attempt: delivery.attempt,
      timestamp: String(timestamp),
      ...(larkSign ? { larkSign } : {}),
    },
  });
  return {
    url: target.url,
    method: target.method,
    body,
    headers: {
      ...target.headers,
      "content-type": `${target.contentType}; charset=utf-8`,
      "user-agent": "ship.live-webhooks/1",
      "x-ship-event": event.type,
      "x-ship-delivery": delivery.id,
      "x-ship-timestamp": String(timestamp),
      ...(target.signing === "ship" && target.secret
        ? { "x-ship-signature": shipSignature(target.secret, timestamp, body) }
        : {}),
    },
  };
}

/** A 2xx response that also matches the configured JSON value, if any. */
export function accepted(
  target: Pick<WebhookTarget, "successPath" | "successValue">,
  response: OutboundResponse,
): { ok: boolean; reason?: string } {
  if (response.status === null)
    return { ok: false, reason: response.error ?? "No response." };
  if (response.status < 200 || response.status > 299)
    return {
      ok: false,
      reason: `The receiver answered HTTP ${response.status}.`,
    };
  if (!target.successPath) return { ok: true };
  let value: unknown;
  try {
    value = readJsonPath(
      JSON.parse(response.body),
      parseJsonPath(target.successPath),
    );
  } catch {
    return { ok: false, reason: "The response is not the expected JSON." };
  }
  return value === target.successValue
    ? { ok: true }
    : {
        ok: false,
        reason: `The response's ${target.successPath} was ${JSON.stringify(value) ?? "missing"}, not ${JSON.stringify(target.successValue)}.`,
      };
}

/**
 * Network errors, 408, 425, 429, 5xx, and failed JSON checks are retried;
 * other 4xx answers are final. 410 Gone also pauses the webhook.
 */
export function outcomeOf(
  target: Pick<WebhookTarget, "successPath" | "successValue">,
  response: OutboundResponse,
  attempt: number,
  requestBody: string,
): DeliveryOutcome {
  const verdict = accepted(target, response);
  const base = {
    requestBody,
    responseStatus: response.status,
    responseBody: response.body.slice(0, 1024) || null,
  };
  if (verdict.ok) return { ...base, status: "succeeded", error: null };
  if (response.status === 410)
    return {
      ...base,
      status: "failed",
      error: "The receiver answered 410 Gone.",
      pause:
        "The receiver answered 410 Gone. Check the URL, then turn the webhook back on.",
    };
  const status = response.status;
  const retryable =
    status === null ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500 ||
    (status >= 200 && status < 300);
  if (!retryable)
    return { ...base, status: "failed", error: verdict.reason ?? "Rejected." };
  if (attempt >= MAX_ATTEMPTS)
    return {
      ...base,
      status: "dead",
      error: `${verdict.reason} Gave up after ${MAX_ATTEMPTS} attempts.`,
    };
  return {
    ...base,
    status: "pending",
    error: verdict.reason ?? null,
    retryInSeconds: Math.max(
      response.retryAfter ?? 0,
      RETRY_SECONDS[attempt - 1],
    ),
  };
}

const finalFailure = (error: string): DeliveryOutcome => ({
  status: "dead",
  requestBody: "",
  responseStatus: null,
  responseBody: null,
  error,
});

export async function performDelivery(
  store: WebhookStore,
  claim: ClaimedDelivery,
  send: Send = sendOutbound,
  now = Date.now(),
  /** Completes events built at send time, such as a webhook's digest. */
  enrich: (
    claim: ClaimedDelivery,
  ) => Promise<WebhookEvent | PreparedDigest> = async () => claim.event,
  /** Whether the webhook's owner may still receive this event. */
  authorize: (claim: ClaimedDelivery) => Promise<boolean> = async () => true,
): Promise<DeliveryOutcome> {
  const attempt = claim.attempts + 1;
  try {
    if (!(await authorize(claim)))
      return {
        status: "failed",
        requestBody: "",
        responseStatus: null,
        responseBody: null,
        error:
          "Not sent: the webhook's owner no longer has access to this event.",
      };
  } catch {
    return attempt >= MAX_ATTEMPTS
      ? finalFailure("Access to the event could not be checked.")
      : {
          status: "pending",
          requestBody: "",
          responseStatus: null,
          responseBody: null,
          error: "Access to the event could not be checked; retrying.",
          retryInSeconds: RETRY_SECONDS[attempt - 1],
        };
  }
  let event: WebhookEvent;
  let scopeAuthorized: (() => Promise<boolean>) | undefined;
  try {
    const prepared = await enrich(claim);
    if ("event" in prepared) {
      event = prepared.event;
      scopeAuthorized = prepared.authorize;
    } else event = prepared;
  } catch {
    return attempt >= MAX_ATTEMPTS
      ? finalFailure("The event could not be prepared.")
      : {
          status: "pending",
          requestBody: "",
          responseStatus: null,
          responseBody: null,
          error: "The event could not be prepared; retrying.",
          retryInSeconds: RETRY_SECONDS[attempt - 1],
        };
  }
  let target: WebhookTarget;
  try {
    target = store.target(claim.webhook);
  } catch {
    return finalFailure(
      "The webhook's sealed settings could not be opened. Save it again.",
    );
  }
  let request: OutboundRequest;
  try {
    request = prepareRequest(target, event, { id: claim.id, attempt }, now);
  } catch (error) {
    return finalFailure(
      error instanceof TemplateError
        ? `The template could not render: ${error.message}`
        : "The body could not be rendered.",
    );
  }
  try {
    if (
      !(await authorize(claim)) ||
      (scopeAuthorized && !(await scopeAuthorized()))
    )
      return {
        status: "failed",
        requestBody: "",
        responseStatus: null,
        responseBody: null,
        error:
          "Not sent: the webhook's owner no longer has access to this event's original scope.",
      };
  } catch {
    return attempt >= MAX_ATTEMPTS
      ? finalFailure("Access to the event could not be checked.")
      : {
          status: "pending",
          requestBody: "",
          responseStatus: null,
          responseBody: null,
          error: "Access to the event could not be checked; retrying.",
          retryInSeconds: RETRY_SECONDS[attempt - 1],
        };
  }
  return outcomeOf(target, await send(request), attempt, request.body);
}

/** Captures repository permissions and source settings alongside an enriched digest. */
export async function enrichDigest(
  pool: Pool,
  access: AccessCheck,
  claim: ClaimedDelivery,
  options: { appUrl?: string; now?: number } = {},
): Promise<WebhookEvent | PreparedDigest> {
  if (claim.event.type !== "digest.weekly") return claim.event;
  const visible = await access(
    claim.webhook.creator_user_id,
    claim.webhook.workspace_id,
  );
  if (!visible) throw new Error("Digest access unavailable.");
  const repositoryIds = claim.webhook.repository_ids
    .map(Number)
    .filter((id) => visible.has(id))
    .sort((a, b) => a - b);
  const prepared = await prepareDigest(
    pool,
    claim.event,
    repositoryIds,
    options,
  );
  return {
    event: prepared.event,
    authorize: async () => {
      const latest = await pool.query<{
        repository_ids: string[];
        creator_user_id: string;
        workspace_id: string;
        enabled: boolean;
      }>(
        "SELECT repository_ids,creator_user_id,workspace_id,enabled FROM ship_live_webhooks WHERE id=$1",
        [claim.webhook.id],
      );
      const hook = latest.rows[0];
      if (
        !hook?.enabled ||
        hook.creator_user_id !== claim.webhook.creator_user_id ||
        hook.workspace_id !== claim.webhook.workspace_id
      )
        return false;
      const current = await access(hook.creator_user_id, hook.workspace_id);
      if (!current) return false;
      const ids = hook.repository_ids
        .map(Number)
        .filter((id) => current.has(id))
        .sort((a, b) => a - b);
      return (
        JSON.stringify(ids) === JSON.stringify(repositoryIds) &&
        (await prepared.authorize())
      );
    },
  };
}

/** Routes events and sends due deliveries, a few at a time per process. */
export function startWebhookWorker({
  pool,
  store,
  access,
  send = sendOutbound,
  concurrency = 4,
  intervalMs = 2000,
  digestIntervalMs = 600_000,
  appUrl,
}: {
  pool: Pool;
  store: WebhookStore;
  access: AccessCheck;
  send?: Send;
  concurrency?: number;
  intervalMs?: number;
  digestIntervalMs?: number;
  appUrl?: string;
}): () => Promise<void> {
  let stopped = false;
  let busy = false;
  let digestsCheckedAt = 0;
  const active = new Set<Promise<void>>();
  const enrich = (claim: ClaimedDelivery) =>
    enrichDigest(pool, access, claim, { appUrl });
  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      if (Date.now() - digestsCheckedAt >= digestIntervalMs) {
        digestsCheckedAt = Date.now();
        await scheduleDigests(pool);
      }
      await routeEvents(pool, access);
      for (const claim of await claimDeliveries(
        pool,
        concurrency - active.size,
      )) {
        const task = performDelivery(
          store,
          claim,
          send,
          Date.now(),
          enrich,
          (item) => ownerMaySee(access, item),
        )
          .then(async (outcome) => {
            deliveries.inc({ outcome: outcome.status });
            await completeDelivery(pool, claim, outcome);
          })
          .catch(() =>
            log.error(
              "A webhook delivery could not be recorded; its lease expires and it is retried.",
              { delivery: claim.id },
            ),
          )
          .finally(() => active.delete(task));
        active.add(task);
      }
    } catch (error) {
      log.error("Webhook worker unavailable; retrying shortly.", { error });
    } finally {
      busy = false;
    }
  }
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    while (busy) await new Promise((resolve) => setTimeout(resolve, 20));
    await Promise.allSettled([...active]);
  };
}
