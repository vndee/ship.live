import type { Pool } from "pg";
import type { WebhookEvent } from "../shared/webhooks.js";
import { getAchievements } from "../src/lib/activity.js";
import { resolvePulseRange } from "../shared/pulse.js";
import { readDigestSummary } from "./digest-store.js";
import { recordWorkspaceEvent } from "./webhook-outbox.js";

const DAY = 86_400_000;
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
 * Queue once per completed UTC week using each workspace's local schedule.
 * PostgreSQL moves nonexistent DST times forward and chooses the later offset
 * for repeated times. Existing installations default to Monday 09:00 UTC.
 * Consider the prior local week too, so polling across Monday still catches
 * the latest due occurrence. Convert each local date separately for DST.
 */
export async function scheduleDigests(
  pool: Pool,
  now = Date.now(),
): Promise<number> {
  const client = await pool.connect();
  let failed = false;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      workspace_id: string;
      week_start: string;
      send_at: Date;
    }>(
      `WITH configured AS (
         SELECT w.id, coalesce(s.weekday,1) AS weekday,
           coalesce(s.local_time,'09:00') AS local_time,coalesce(s.timezone,'UTC') AS timezone
         FROM ship_live_workspaces w LEFT JOIN ship_live_digest_schedules s ON s.workspace_id=w.id
       ), candidates AS (
         SELECT id, (date_trunc('week',$1::timestamptz AT TIME ZONE timezone)
           - lookback.days*interval '1 day'
           + ((weekday+6)%7)*interval '1 day' + local_time::time) AT TIME ZONE timezone AS send_at
         FROM configured CROSS JOIN (VALUES (0),(7)) AS lookback(days)
       ), scheduled AS (
         SELECT id,max(send_at) AS send_at FROM candidates
         WHERE send_at <= $1::timestamptz GROUP BY id
       ), due AS (
         SELECT id,send_at,(date_trunc('week',send_at AT TIME ZONE 'UTC')-interval '7 days')::date AS week_start
         FROM scheduled
       ), inserted AS (
         INSERT INTO ship_live_digest_runs(workspace_id,week_start)
         SELECT d.id,d.week_start FROM due d WHERE EXISTS(
           SELECT 1 FROM ship_live_webhooks h WHERE h.workspace_id=d.id AND h.enabled
             AND 'digest.weekly'=ANY(h.events) AND h.created_at<=d.send_at)
         ON CONFLICT DO NOTHING RETURNING workspace_id,week_start
       ) SELECT i.workspace_id,to_char(i.week_start,'YYYY-MM-DD') AS week_start,d.send_at
         FROM inserted i JOIN due d ON d.id=i.workspace_id`,
      [new Date(now)],
    );
    for (const row of rows) {
      const start = Date.parse(`${row.week_start}T00:00:00Z`);
      await recordWorkspaceEvent(client, row.workspace_id, {
        type: "digest.weekly",
        dedupeKey: `digest:${row.week_start}`,
        occurredAt: row.send_at.toISOString(),
        summary: `Weekly digest for the week of ${row.week_start}`,
        data: { weekStart: row.week_start, weekEnd: day(start + 6 * DAY) },
      });
    }
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
export interface PreparedDigest {
  event: WebhookEvent;
  /** Recheck the exact scope used to build this payload before sending it. */
  authorize: () => Promise<boolean>;
}

export async function prepareDigest(
  pool: Pool,
  event: WebhookEvent,
  repositoryIds: number[],
  { appUrl, now = Date.now() }: { appUrl?: string; now?: number } = {},
): Promise<PreparedDigest> {
  const start = Date.parse(`${String(event.data.weekStart)}T00:00:00Z`);
  if (!Number.isFinite(start)) return { event, authorize: async () => false };
  const end = start + 7 * DAY;
  // A team reads its installation. A journal reads each of its sources, and only
  // its owner's activity when it keeps only theirs.
  const readScope = () =>
    pool.query<{
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
  const { rows: workspaces } = await readScope();
  const scopeKey = (
    value: { installations: string[]; author: string | null } | undefined,
  ) =>
    value
      ? JSON.stringify([
          [...value.installations].sort(),
          value.author?.toLowerCase() ?? null,
        ])
      : null;
  const initialScope = scopeKey(workspaces[0]);
  const installations = (workspaces[0]?.installations ?? []).map(Number);
  const author = workspaces[0]?.author?.toLowerCase() ?? undefined;
  const range = resolvePulseRange(
    { period: "custom", from: day(start), to: day(end - DAY) },
    Math.max(now, end),
  );
  const summary = await readDigestSummary(pool, {
    installations,
    repositoryIds,
    author,
    start: range.start,
    end: range.end,
    now,
  });
  const { shipped, helpfulReviewers, totals: metrics } = summary;
  const needsHelp = {
    basis: "current",
    checkedAt: new Date(now).toISOString(),
    note: "Latest stored PR status at delivery; not a historical snapshot of the digest week.",
    items: summary.needsHelp,
  };
  // Reuse the dashboard's milestone definitions; progress comes from the full
  // SQL counts, not synthetic events or a bounded highlights list.
  const next = getAchievements([], end - 1)
    .map((item) => {
      const count =
        item.kind === "merge"
          ? metrics.merges
          : item.kind === "review"
            ? metrics.reviews
            : metrics.releases;
      return {
        ...item,
        progress: Math.min(count, item.target),
        unlocked: count >= item.target,
      };
    })
    .filter((item) => !item.unlocked)
    .sort((a, b) => b.progress / b.target - a.progress / a.target)[0];
  const nextMilestone = next
    ? { ...next, remaining: next.target - next.progress, basis: "digest_week" }
    : null;
  const link = (scene: string, weekly = true) => {
    if (!appUrl) return undefined;
    const url = new URL("/", appUrl);
    url.searchParams.set("workspace", event.workspace.id);
    url.searchParams.set("scene", scene);
    if (weekly) {
      url.searchParams.set("period", "custom");
      url.searchParams.set("from", day(start));
      url.searchParams.set("to", day(end - DAY));
    }
    return url.href;
  };
  const links = {
    pulse: link("pulse"),
    review: link("review"),
    reviewers: link("leaderboard"),
    milestones: link("pulse"),
    currentReview: link("review", false),
  };
  const coverage = {
    basis: "stored_activity",
    note: "Based on stored GitHub activity in this webhook's authorized repositories; missing history may lower totals. PR status uses latest stored signals.",
  };
  const compact = (value: string, length = 80) => {
    const text = value.replace(/\s+/g, " ").trim();
    return text.length > length ? text.slice(0, length - 1) + "…" : text;
  };
  // Keep context and section links before bounded excerpts so chat limits never
  // turn a partial list into a claim of complete history or hide its date scope.
  const lines = [
    `Week of ${day(start)}–${day(end - DAY)} (UTC)`,
    coverage.note,
    nextMilestone
      ? `Next weekly milestone: ${nextMilestone.title} (${nextMilestone.progress}/${nextMilestone.target}; ${nextMilestone.remaining} to go at week end).${links.milestones ? ` ${links.milestones}` : ""}`
      : "All weekly milestones reached in stored activity.",
    helpfulReviewers.length
      ? `Thanks for reviewing teammates' PRs: ${helpfulReviewers.map((item) => `${compact(item.login, 39)} (${item.pullRequests} PR${item.pullRequests === 1 ? "" : "s"})`).join(", ")}`
      : "No cross-author reviews could be confirmed from stored PR data.",
    links.reviewers ? `Reviewers this week: ${links.reviewers}` : "",
    links.review ? `Reviews this week: ${links.review}` : "",
    links.currentReview ? `Recent review activity: ${links.currentReview}` : "",
    needsHelp.items.length
      ? "Current PRs needing help (highlights):"
      : "No current PRs needing help found in stored signals.",
  ].filter(Boolean);
  const append = (line: string) => {
    if (lines.join("\n").length + line.length + 1 <= 2700) lines.push(line);
  };
  for (const item of needsHelp.items.slice(0, 3))
    append(
      `${compact(item.repository)} #${item.number} — ${item.state === "failing" ? "checks failing" : "review or follow-up needed"}: ${item.url}`,
    );
  append(
    shipped.length
      ? "Shipped highlights:"
      : "No merges or releases found in stored activity for this week.",
  );
  for (const item of shipped.slice(0, 3))
    append(
      `${compact(item.repository)}: ${compact(item.title)}${item.url ? ` — ${item.url}` : ""}`,
    );
  const body = lines.join("\n");
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
  const result: WebhookEvent = {
    ...event,
    ...(links.pulse ? { url: links.pulse } : {}),
    summary: `${event.workspace.name}'s week: ${plural(metrics.merges, "merge")}, ${plural(metrics.reviews, "review")}, ${plural(metrics.releases, "release")} from ${metrics.contributors} ${metrics.contributors === 1 ? "person" : "people"}`,
    data: {
      body,
      shipped,
      helpfulReviewers,
      needsHelp,
      nextMilestone,
      links,
      coverage,
      weekStart: day(start),
      weekEnd: day(end - DAY),
      totals: {
        merges: metrics.merges,
        reviews: metrics.reviews,
        releases: metrics.releases,
        contributors: metrics.contributors,
        xp: metrics.xp,
      },
      topContributors: summary.topContributors,
      repositories: summary.repositories,
      services: services.map((service) => ({
        name: service.name,
        uptime: service.checks ? service.passed / service.checks : null,
        incidents: service.incidents,
      })),
    },
  };
  return {
    event: result,
    authorize: async () =>
      initialScope !== null &&
      initialScope === scopeKey((await readScope()).rows[0]),
  };
}

/** Read-only payload convenience; senders must retain prepareDigest's scope guard. */
export async function withDigest(
  ...args: Parameters<typeof prepareDigest>
): Promise<WebhookEvent> {
  return (await prepareDigest(...args)).event;
}
