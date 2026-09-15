import type { Pool } from "pg";
import type { ActivityEvent } from "../shared/types.js";
import type { WebhookEvent } from "../shared/webhooks.js";
import { getLeaderboard, getMetrics } from "../src/lib/activity.js";
import { recordWorkspaceEvent } from "./webhook-outbox.js";

const DAY = 86_400_000;
const SEND_HOUR = 9;
const day = (time: number) => new Date(time).toISOString().slice(0, 10);

/** Monday 00:00 UTC of the week containing a time. */
export function mondayOf(time: number): number {
  const date = new Date(time);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() - ((date.getUTCDay() + 6) % 7),
  );
}

/**
 * After Monday 09:00 UTC, queues last week's digest once for each team
 * workspace with a webhook that listened since before then. The run table
 * makes this idempotent across replicas and restarts.
 */
export async function scheduleDigests(
  pool: Pool,
  now = Date.now(),
): Promise<number> {
  const monday = mondayOf(now);
  const sendAt = monday + SEND_HOUR * 3_600_000;
  if (now < sendAt) return 0;
  const weekStart = day(monday - 7 * DAY);
  const client = await pool.connect();
  let failed = false;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ workspace_id: string }>(
      `INSERT INTO ship_live_digest_runs (workspace_id, week_start)
       SELECT w.id, $1::date FROM ship_live_workspaces w
       WHERE EXISTS (
         SELECT 1 FROM ship_live_webhooks h
         WHERE h.workspace_id = w.id AND h.enabled
           AND 'digest.weekly' = ANY(h.events) AND h.created_at <= $2)
       ON CONFLICT DO NOTHING RETURNING workspace_id`,
      [weekStart, new Date(sendAt)],
    );
    for (const { workspace_id } of rows)
      await recordWorkspaceEvent(client, workspace_id, {
        type: "digest.weekly",
        dedupeKey: `digest:${weekStart}`,
        // Routing compares this with each webhook's creation time.
        occurredAt: new Date(sendAt).toISOString(),
        summary: `Weekly digest for the week of ${weekStart}`,
        data: { weekStart, weekEnd: day(monday - DAY) },
      });
    await client.query("COMMIT");
    return rows.length;
  } catch (error) {
    failed = true;
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release(failed);
  }
}

/**
 * Fills a digest for one webhook when it is sent: activity counts, top people
 * (by the leaderboard's XP rules), and busiest repositories from only the
 * repositories that webhook may see, plus each service's uptime that week.
 */
export async function withDigest(
  pool: Pool,
  event: WebhookEvent,
  repositoryIds: number[],
): Promise<WebhookEvent> {
  const start = Date.parse(`${String(event.data.weekStart)}T00:00:00Z`);
  if (!Number.isFinite(start)) return event;
  const end = start + 7 * DAY;
  // A team reads its installation. A journal reads each of its sources, and only
  // its owner's activity when it keeps only theirs.
  const { rows: workspaces } = await pool.query<{
    installations: string[];
    author: string | null;
  }>(
    `SELECT ARRAY(
       SELECT c.installation_id FROM ship_live_workspaces c
       WHERE c.installation_id IS NOT NULL AND (
         (w.kind = 'team' AND c.id = w.id)
         OR (w.kind = 'personal'
           AND (w.source_installation_ids IS NULL OR c.installation_id = ANY(w.source_installation_ids))
           AND (c.id = w.id OR EXISTS (SELECT 1 FROM ship_live_workspace_members m
             WHERE m.workspace_id = c.id AND m.user_id = w.owner_user_id))))
     )::text[] AS installations,
     CASE WHEN w.kind = 'personal' AND w.source_mine_only THEN coalesce(g.login, '') END AS author
     FROM ship_live_workspaces w
     LEFT JOIN ship_live_github_connections g ON g.user_id = w.owner_user_id
     WHERE w.id = $1`,
    [event.workspace.id],
  );
  const scopes = (workspaces[0]?.installations ?? []).map(
    (id) => `installation-${id}`,
  );
  const activity =
    scopes.length && repositoryIds.length
      ? (
          await pool.query<{ event: ActivityEvent }>(
            `SELECT event FROM ship_live_events
             WHERE organization = ANY($1::text[]) AND occurred_at >= $2 AND occurred_at < $3
               AND (event->>'repositoryId')::bigint = ANY($4::bigint[])
               AND ($5::text IS NULL OR lower(event->'actor'->>'login') = lower($5))
             ORDER BY occurred_at LIMIT 20000`,
            [
              scopes,
              new Date(start),
              new Date(end),
              repositoryIds,
              workspaces[0]?.author ?? null,
            ],
          )
        ).rows.map((row) => row.event)
      : [];
  // A moment inside the digest week, so the weekly rules count that week.
  const during = end - 1;
  const metrics = getMetrics(activity, during);
  const counts = new Map<
    string,
    { name: string; merges: number; reviews: number }
  >();
  for (const item of activity) {
    if (item.type !== "merge" && item.type !== "review") continue;
    const entry = counts.get(item.repo) ?? {
      name: item.repo,
      merges: 0,
      reviews: 0,
    };
    entry[item.type === "merge" ? "merges" : "reviews"] += 1;
    counts.set(item.repo, entry);
  }
  const { rows: services } = await pool.query<{
    name: string;
    checks: number;
    passed: number;
    incidents: number;
  }>(
    `SELECT s.name,
       count(c.id)::int AS checks,
       (count(c.id) FILTER (WHERE (c.result->>'ok')::boolean))::int AS passed,
       (SELECT count(*)::int FROM ship_live_health_incidents i
        WHERE i.service_id = s.id AND i.opened_at >= $2 AND i.opened_at < $3) AS incidents
     FROM ship_live_health_services s
     LEFT JOIN ship_live_health_probes p ON p.service_id = s.id
     LEFT JOIN ship_live_health_checks c
       ON c.probe_id = p.id AND c.checked_at >= $2 AND c.checked_at < $3
     WHERE s.workspace_id = $1
     GROUP BY s.id, s.name, s.display_order
     ORDER BY s.display_order, s.name LIMIT 50`,
    [event.workspace.id, new Date(start), new Date(end)],
  );
  const plural = (count: number, word: string) =>
    `${count} ${word}${count === 1 ? "" : "s"}`;
  return {
    ...event,
    summary: `${event.workspace.name}'s week: ${plural(metrics.merges, "merge")}, ${plural(metrics.reviews, "review")}, ${plural(metrics.releases, "release")} from ${metrics.contributors} ${metrics.contributors === 1 ? "person" : "people"}`,
    data: {
      weekStart: day(start),
      weekEnd: day(end - DAY),
      totals: {
        merges: metrics.merges,
        reviews: metrics.reviews,
        releases: metrics.releases,
        contributors: metrics.contributors,
        xp: metrics.xp,
      },
      topContributors: getLeaderboard(activity, during)
        .slice(0, 5)
        .map(({ login, xp, merges, reviews }) => ({
          login,
          xp,
          merges,
          reviews,
        })),
      repositories: [...counts.values()]
        .sort((a, b) => b.merges + b.reviews - (a.merges + a.reviews))
        .slice(0, 5),
      services: services.map((service) => ({
        name: service.name,
        uptime: service.checks ? service.passed / service.checks : null,
        incidents: service.incidents,
      })),
    },
  };
}
