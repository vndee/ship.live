import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { filtersMatch } from "../shared/webhook-filters.js";
import {
  eventMatches,
  WEBHOOK_PAYLOAD_VERSION,
  type WebhookEvent,
} from "../shared/webhooks.js";
import type { OutboxEvent } from "./webhook-events.js";
import type { WebhookRow } from "./webhook-store.js";

type Queryable = Pool | PoolClient;

const payload = (event: OutboxEvent) =>
  JSON.stringify({
    occurredAt: event.occurredAt,
    summary: event.summary,
    url: event.url,
    data: event.data,
  });

// Events are stored only for team workspaces with a webhook listening, so an
// unused feature adds no rows. Inbound alerts are always kept: Live activity
// shows them too.
const LISTENING = `($2::text LIKE 'inbound.%' OR EXISTS (SELECT 1 FROM ship_live_webhooks h
  WHERE h.workspace_id = w.id AND h.enabled AND $2::text = ANY(h.events)))`;

// A journal follows an installation its owner connected and chose as a source.
// When it keeps only its owner's activity, others' activity is not stored for it.
const FOLLOWING = `(w.kind = 'personal'
  AND (w.source_installation_ids IS NULL OR $1::bigint = ANY(w.source_installation_ids))
  AND EXISTS (SELECT 1 FROM ship_live_workspaces c WHERE c.installation_id = $1
    AND (c.owner_user_id = w.owner_user_id OR EXISTS (SELECT 1 FROM ship_live_workspace_members m
      WHERE m.workspace_id = c.id AND m.user_id = w.owner_user_id)))
  AND (NOT w.source_mine_only OR $6::text IS NULL OR EXISTS (SELECT 1 FROM ship_live_github_connections g
    WHERE g.user_id = w.owner_user_id AND lower(g.login) = lower($6))))`;

/**
 * Stores a workspace event in the caller's transaction, so it commits or
 * rolls back with the change that caused it.
 */
export async function recordWorkspaceEvent(
  client: Queryable,
  workspaceId: string,
  event: OutboxEvent,
): Promise<void> {
  await client.query(
    `INSERT INTO ship_live_webhook_events (id, workspace_id, type, payload, dedupe_key, repository_id)
     SELECT gen_random_uuid(), w.id, $2, $3, $4, $5 FROM ship_live_workspaces w
     WHERE w.id = $1 AND ${LISTENING}
     ON CONFLICT (workspace_id, dedupe_key) DO NOTHING`,
    [
      workspaceId,
      event.type,
      payload(event),
      event.dedupeKey,
      event.repositoryId ?? null,
    ],
  );
}

/** Stores a GitHub installation's event for its team workspace. */
export async function recordInstallationEvent(
  client: Queryable,
  installationId: number,
  event: OutboxEvent,
): Promise<void> {
  await client.query(
    `INSERT INTO ship_live_webhook_events (id, workspace_id, type, payload, dedupe_key, repository_id)
     SELECT gen_random_uuid(), w.id, $2, $3, $4, $5 FROM ship_live_workspaces w
     WHERE ${LISTENING} AND ((w.kind = 'team' AND w.installation_id = $1) OR ${FOLLOWING})
     ON CONFLICT (workspace_id, dedupe_key) DO NOTHING`,
    [
      installationId,
      event.type,
      payload(event),
      event.dedupeKey,
      event.repositoryId ?? null,
      event.actor ?? null,
    ],
  );
}

interface EventRow {
  id: string;
  workspace_id: string;
  workspace_name: string;
  type: string;
  payload: {
    occurredAt: string;
    summary: string;
    url?: string;
    data: Record<string, unknown>;
  };
  repository_id: string | number | null;
}

export function webhookEvent(
  row: Pick<
    EventRow,
    "id" | "workspace_id" | "workspace_name" | "type" | "payload"
  >,
): WebhookEvent {
  return {
    version: WEBHOOK_PAYLOAD_VERSION,
    id: row.id,
    type: row.type,
    occurredAt: row.payload.occurredAt,
    workspace: { id: row.workspace_id, name: row.workspace_name },
    summary: row.payload.summary,
    ...(row.payload.url ? { url: row.payload.url } : {}),
    data: row.payload.data,
  };
}

/**
 * Repository IDs a user can see in a workspace right now, or undefined when
 * they are no longer a member or have no access snapshot.
 */
export type AccessCheck = (
  userId: string,
  workspaceId: string,
) => Promise<Set<number> | undefined>;

// Recoveries always go out and end the cooldown for their alert.
const RECOVERIES = new Set([
  "health.recovered",
  "incident.resolved",
  "pipeline.recovered",
  "deployment.succeeded",
]);

/** Alerts about the same thing share a cooldown; activity never waits. */
function cooldownKey(row: EventRow): string | undefined {
  const data = row.payload.data as Record<string, Record<string, unknown>>;
  if (row.type.startsWith("health.") || row.type.startsWith("incident."))
    return `probe:${data.probe?.id}`;
  if (row.type.startsWith("pipeline."))
    return `pipeline:${row.repository_id}:${data.pipeline?.name}`;
  if (row.type.startsWith("deployment."))
    return `deployment:${row.repository_id}:${data.deployment?.environment}`;
  if (row.type.startsWith("inbound.")) return row.type;
  return undefined;
}

/** Whether this alert falls inside a running cooldown; starts one if not. */
async function coolingDown(
  client: PoolClient,
  hook: WebhookRow,
  row: EventRow,
): Promise<boolean> {
  const key = cooldownKey(row);
  if (!hook.cooldown_seconds || !key) return false;
  if (RECOVERIES.has(row.type)) {
    await client.query(
      "DELETE FROM ship_live_webhook_cooldowns WHERE webhook_id=$1 AND key=$2",
      [hook.id, key],
    );
    return false;
  }
  const { rowCount } = await client.query(
    `INSERT INTO ship_live_webhook_cooldowns (webhook_id, key, until)
     VALUES ($1, $2, now() + make_interval(secs => $3))
     ON CONFLICT (webhook_id, key) DO UPDATE SET until = EXCLUDED.until
       WHERE ship_live_webhook_cooldowns.until <= now()`,
    [hook.id, key, hook.cooldown_seconds],
  );
  return !rowCount;
}

/**
 * Turns stored events into deliveries for every matching webhook. Activity
 * and CI events go only to webhooks whose owner pinned the repository and can
 * still see it. Replicas route different events at the same time.
 */
export async function routeEvents(
  pool: Pool,
  access: AccessCheck,
  limit = 50,
): Promise<number> {
  const client = await pool.connect();
  let failed = false;
  try {
    await client.query("BEGIN");
    const { rows: events } = await client.query<EventRow>(
      `SELECT e.id, e.workspace_id, w.name AS workspace_name, e.type, e.payload, e.repository_id
       FROM ship_live_webhook_events e
       JOIN ship_live_workspaces w ON w.id = e.workspace_id
       WHERE e.routed_at IS NULL
       ORDER BY e.created_at, e.id LIMIT $1
       FOR UPDATE OF e SKIP LOCKED`,
      [limit],
    );
    if (!events.length) {
      await client.query("COMMIT");
      return 0;
    }
    const { rows: hooks } = await client.query<WebhookRow>(
      "SELECT * FROM ship_live_webhooks WHERE workspace_id = ANY($1::uuid[]) AND enabled ORDER BY created_at",
      [[...new Set(events.map((event) => event.workspace_id))]],
    );
    const allowed = new Map<string, Promise<Set<number> | undefined>>();
    for (const row of events) {
      const event = webhookEvent(row);
      for (const hook of hooks) {
        if (
          hook.workspace_id !== row.workspace_id ||
          !eventMatches(hook.events, row.type) ||
          !filtersMatch(hook.filters, event) ||
          // A webhook added after a digest's send time starts next week.
          (row.type === "digest.weekly" &&
            hook.created_at.getTime() > Date.parse(row.payload.occurredAt))
        )
          continue;
        const key = `${hook.creator_user_id}:${hook.workspace_id}`;
        if (!allowed.has(key))
          allowed.set(key, access(hook.creator_user_id, hook.workspace_id));
        const repositories = await allowed.get(key);
        if (!repositories) continue;
        if (row.repository_id !== null) {
          const repository = Number(row.repository_id);
          if (
            !repositories.has(repository) ||
            !hook.repository_ids.map(Number).includes(repository)
          )
            continue;
        }
        const skipped = await coolingDown(client, hook, row);
        await client.query(
          `INSERT INTO ship_live_webhook_deliveries (id, webhook_id, event_id, status, error, finished_at)
           VALUES ($1, $2, $3, $4, $5, CASE WHEN $4 = 'skipped' THEN now() END)
           ON CONFLICT (webhook_id, event_id) DO NOTHING`,
          [
            randomUUID(),
            hook.id,
            row.id,
            skipped ? "skipped" : "pending",
            skipped ? "Skipped: this alert is inside its cooldown." : null,
          ],
        );
      }
    }
    await client.query(
      "UPDATE ship_live_webhook_events SET routed_at = now() WHERE id = ANY($1::uuid[])",
      [events.map((event) => event.id)],
    );
    await client.query("COMMIT");
    return events.length;
  } catch (error) {
    failed = true;
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release(failed);
  }
}

export interface ClaimedDelivery {
  id: string;
  lease: string;
  attempts: number;
  webhook: WebhookRow;
  event: WebhookEvent;
  /** The event's repository, when it has one. */
  repositoryId: number | null;
}

/** Leases due deliveries of enabled webhooks; an expired lease is retried. */
export async function claimDeliveries(
  pool: Pool,
  limit: number,
): Promise<ClaimedDelivery[]> {
  if (limit <= 0) return [];
  const { rows } = await pool.query<{
    id: string;
    lease: string;
    attempts: number;
    webhook: WebhookRow;
    event: EventRow;
  }>(
    `WITH due AS (
       SELECT d.id FROM ship_live_webhook_deliveries d
       JOIN ship_live_webhooks h ON h.id = d.webhook_id AND h.enabled
       WHERE d.status = 'pending' AND d.next_attempt_at <= now()
         AND (d.lease_until IS NULL OR d.lease_until < now())
       ORDER BY d.next_attempt_at, d.id LIMIT $1
       FOR UPDATE OF d SKIP LOCKED
     ), claimed AS (
       UPDATE ship_live_webhook_deliveries d
       SET lease = gen_random_uuid(), lease_until = now() + interval '60 seconds'
       FROM due WHERE d.id = due.id
       RETURNING d.id, d.lease, d.attempts, d.webhook_id, d.event_id
     )
     SELECT c.id, c.lease, c.attempts, to_jsonb(h) AS webhook,
       jsonb_build_object('id', e.id, 'workspace_id', e.workspace_id,
         'workspace_name', w.name, 'type', e.type, 'payload', e.payload, 'repository_id', e.repository_id) AS event
     FROM claimed c
     JOIN ship_live_webhooks h ON h.id = c.webhook_id
     JOIN ship_live_webhook_events e ON e.id = c.event_id
     JOIN ship_live_workspaces w ON w.id = e.workspace_id`,
    [limit],
  );
  return rows.map((row) => ({
    id: row.id,
    lease: row.lease,
    attempts: row.attempts,
    webhook: row.webhook,
    event: webhookEvent(row.event),
    repositoryId:
      row.event.repository_id === null || row.event.repository_id === undefined
        ? null
        : Number(row.event.repository_id),
  }));
}

/**
 * Whether a delivery's owner may still receive its event: still a member,
 * and still seeing and pinning its repository when it has one. Checked before
 * every attempt, because retries can come hours after routing.
 */
export async function ownerMaySee(
  access: AccessCheck,
  claim: Pick<ClaimedDelivery, "webhook" | "repositoryId">,
): Promise<boolean> {
  const visible = await access(
    claim.webhook.creator_user_id,
    claim.webhook.workspace_id,
  );
  if (!visible) return false;
  return (
    claim.repositoryId === null ||
    (visible.has(claim.repositoryId) &&
      claim.webhook.repository_ids.map(Number).includes(claim.repositoryId))
  );
}

export interface DeliveryOutcome {
  status: "succeeded" | "pending" | "failed" | "dead";
  requestBody: string;
  responseStatus: number | null;
  responseBody: string | null;
  error: string | null;
  /** When status is pending: seconds until the next attempt. */
  retryInSeconds?: number;
  /** Turns the webhook off with this explanation. */
  pause?: string;
}

/** Records an attempt unless the lease expired and another worker took over. */
export async function completeDelivery(
  pool: Pool,
  claim: Pick<ClaimedDelivery, "id" | "lease" | "webhook">,
  outcome: DeliveryOutcome,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE ship_live_webhook_deliveries SET status=$3, attempts=attempts+1,
       request_body=$4, response_status=$5, response_body=$6, error=$7,
       next_attempt_at = CASE WHEN $3 = 'pending' THEN now() + make_interval(secs => $8) ELSE next_attempt_at END,
       finished_at = CASE WHEN $3 = 'pending' THEN NULL ELSE now() END,
       lease=NULL, lease_until=NULL
     WHERE id=$1 AND lease=$2`,
    [
      claim.id,
      claim.lease,
      outcome.status,
      outcome.requestBody.slice(0, 16_384),
      outcome.responseStatus,
      outcome.responseBody?.slice(0, 1024) || null,
      outcome.error,
      outcome.retryInSeconds ?? 0,
    ],
  );
  if (rowCount && outcome.pause)
    await pool.query(
      "UPDATE ship_live_webhooks SET enabled=false, paused_reason=$2, updated_at=now() WHERE id=$1",
      [claim.webhook.id, outcome.pause],
    );
  return Boolean(rowCount);
}
