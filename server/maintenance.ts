import type { Pool } from "pg";
import { log } from "./logger.js";
import { retentionDeleted } from "./metrics.js";

export interface RetentionPolicy {
  /** GitHub activity and wall signals; 0 keeps them indefinitely. */
  eventDays: number;
  /** Accepted webhook delivery IDs, kept only for deduplication; 0 keeps them. */
  deliveryDays: number;
}

const BATCH = 5_000;
// Bounds one run to about a million rows so it never holds the lock for long.
const MAX_BATCHES = 200;

interface Task {
  table: string;
  condition: string;
  days?: number;
}

/**
 * Tables and conditions are fixed here, never taken from input. Open pull
 * requests stay on Review Radar however long they have been idle; journal
 * notes live in their own table and never expire.
 */
function tasks(policy: RetentionPolicy): Task[] {
  const list: Task[] = [
    {
      table: "ship_live_rate_limits",
      condition: "window_start < now() - interval '1 hour'",
    },
    {
      table: "ship_live_webhook_cooldowns",
      condition: "until < now()",
    },
    // Webhook logs keep 30 days; an event waits while a delivery is pending.
    {
      table: "ship_live_webhook_deliveries",
      condition:
        "created_at < now() - interval '30 days' AND status <> 'pending'",
    },
    {
      table: "ship_live_webhook_events",
      condition: `created_at < now() - interval '30 days' AND routed_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM ship_live_webhook_deliveries d
          WHERE d.event_id = ship_live_webhook_events.id AND d.status = 'pending')`,
    },
    {
      table: "ship_live_inbound_receipts",
      condition: "received_at < now() - interval '30 days'",
    },
    // Incident history feeds uptime reports, so it stays for a year.
    {
      table: "ship_live_health_incidents",
      condition: "resolved_at < now() - interval '1 year'",
    },
    {
      table: "ship_live_health_maintenance",
      condition: "ends_at < now() - interval '90 days'",
    },
    {
      table: "ship_live_digest_runs",
      condition: "week_start < now() - interval '1 year'",
    },
  ];
  if (policy.deliveryDays > 0)
    list.push(
      {
        table: "ship_live_deliveries",
        condition: "received_at < now() - make_interval(days => $1)",
        days: policy.deliveryDays,
      },
      {
        table: "ship_live_wall_deliveries",
        condition: "received_at < now() - make_interval(days => $1)",
        days: policy.deliveryDays,
      },
    );
  if (policy.eventDays > 0)
    list.push(
      {
        table: "ship_live_events",
        condition: "occurred_at < now() - make_interval(days => $1)",
        days: policy.eventDays,
      },
      {
        table: "ship_live_wall_signals",
        condition:
          "observed_at < now() - make_interval(days => $1) AND NOT (kind = 'pull_request' AND value->>'state' = 'open')",
        days: policy.eventDays,
      },
    );
  return list;
}

/**
 * Deletes expired rows in small batches. One replica runs at a time; others
 * skip the run while it holds the advisory lock. Returns rows removed per table.
 */
export async function runRetention(
  pool: Pool,
  policy: RetentionPolicy,
): Promise<Record<string, number>> {
  const client = await pool.connect();
  let failed = false;
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(1936222576, 2) AS locked",
    );
    if (!rows[0].locked) return {};
    try {
      const removed: Record<string, number> = {};
      for (const task of tasks(policy)) {
        let total = 0;
        for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
          const params: unknown[] = task.days === undefined ? [] : [task.days];
          const result = await client.query(
            `DELETE FROM ${task.table} WHERE ctid = ANY(ARRAY(
               SELECT ctid FROM ${task.table} WHERE ${task.condition} LIMIT ${BATCH}
             ))`,
            params,
          );
          total += result.rowCount ?? 0;
          if ((result.rowCount ?? 0) < BATCH) break;
        }
        if (total) {
          removed[task.table] = total;
          retentionDeleted.inc({ table: task.table }, total);
        }
      }
      return removed;
    } finally {
      await client.query("SELECT pg_advisory_unlock(1936222576, 2)");
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    client.release(failed);
  }
}

/** Runs retention shortly after startup and then hourly. */
export function startRetention(
  pool: Pool,
  policy: RetentionPolicy,
  intervalMs = 3_600_000,
): () => Promise<void> {
  let running: Promise<void> | undefined;
  const run = () => {
    running ??= runRetention(pool, policy)
      .then((removed) => {
        if (Object.keys(removed).length)
          log.info("Retention removed expired rows.", removed);
      })
      .catch((error: unknown) =>
        log.error("Retention could not run; it will retry.", { error }),
      )
      .finally(() => {
        running = undefined;
      });
  };
  const first = setTimeout(run, 30_000);
  const timer = setInterval(run, intervalMs);
  first.unref();
  timer.unref();
  return async () => {
    clearTimeout(first);
    clearInterval(timer);
    await running;
  };
}
