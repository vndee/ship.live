import { Router } from "express";
import { Client, type Pool } from "pg";
import type { Workspace } from "../shared/workspaces.js";
import {
  DEFAULT_DIGEST_SCHEDULE,
  parseDigestSchedule,
  resolveRecapWeek,
  recapMarkdown,
  RECAP_DAY,
  type Recap,
  type DigestSchedule,
} from "../shared/recap.js";
import { AuthError, type AuthService, type Principal } from "./auth.js";
import { readDigestSummary } from "./digest-store.js";

type Scope = {
  workspace: Workspace;
  sources: { installationId: number; repositories: { id: number }[] }[];
  author?: string;
};
const fingerprint = (s: Scope) =>
  JSON.stringify([
    s.workspace.id,
    s.workspace.kind,
    s.author ?? null,
    s.sources
      .map((i) => [
        i.installationId,
        i.repositories.map((r) => r.id).sort((a, b) => a - b),
      ])
      .sort((a, b) => Number(a[0]) - Number(b[0])),
  ]);

export function recapRouter({
  auth,
  store,
  viewer,
  now = Date.now,
}: {
  auth: AuthService;
  store: { pool: Pool };
  viewer: (principal: Principal, id: string) => Promise<Scope>;
  now?: () => number;
}) {
  const router = Router(),
    base = "/api/workspaces/:id/recap",
    pool = store.pool;
  function week(value: unknown, time: number) {
    try {
      if (value !== undefined && typeof value !== "string")
        throw new Error("Invalid week.");
      return resolveRecapWeek(value, time);
    } catch (e) {
      throw new AuthError(400, (e as Error).message);
    }
  }
  async function recheck(principal: Principal, id: string, scope: Scope) {
    const current = await viewer(principal, id);
    await auth.assertActive(principal);
    if (fingerprint(scope) !== fingerprint(current))
      throw new AuthError(403, "Repository access changed. Reload the recap.");
  }
  // Serialize saves and use at most one extra connection per router. Auth and
  // viewer query the shared pool, so holding its last client across a recheck
  // would deadlock. Each short-lived write connection closes before the next save.
  let mutationTail: Promise<void> = Promise.resolve();
  function save(
    principal: Principal,
    id: string,
    scope: Scope,
    sql: string,
    values: unknown[],
  ) {
    const pending = mutationTail.then(async () => {
      // Requests may have queued while their original access was revoked.
      await recheck(principal, id, scope);
      const client = new Client(pool.options);
      let connectionError: Error | undefined;
      // Connection failures can arrive while the shared-pool recheck is pending.
      client.on("error", (error: Error) => {
        connectionError = error;
      });
      try {
        await client.connect();
        await client.query("BEGIN");
        await client.query(sql, values);
        await recheck(principal, id, scope);
        if (connectionError) throw connectionError;
        await client.query("COMMIT");
      } catch (error) {
        // A broken connection may reject rollback too; never mask the cause or
        // reuse that connection. Closing it also discards any open transaction.
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        await client.end().catch(() => {});
      }
    });
    mutationTail = pending.then(
      () => {},
      () => {},
    );
    return pending;
  }
  async function read(
    principal: Principal,
    id: string,
    value: unknown,
  ): Promise<Recap> {
    const time = now(),
      range = week(value, time),
      initial = await viewer(principal, id);
    const summary = await readDigestSummary(pool, {
      installations: initial.sources.map((s) => s.installationId),
      sources: initial.sources.map((s) => ({
        installationId: s.installationId,
        repositoryIds: s.repositories.map((r) => r.id),
      })),
      repositoryIds: [
        ...new Set(
          initial.sources.flatMap((s) => s.repositories.map((r) => r.id)),
        ),
      ],
      author: initial.author,
      start: `${range.weekStart}T00:00:00Z`,
      end: new Date(
        Date.parse(`${range.weekStart}T00:00:00Z`) + 7 * RECAP_DAY,
      ).toISOString(),
      now: time,
    });
    const { rows: notes } = await pool.query<{ reflection: string }>(
      "SELECT reflection FROM ship_live_recap_notes WHERE workspace_id=$1 AND user_id=$2 AND week_start=$3::date",
      [id, principal.user.id, range.weekStart],
    );
    const { rows: schedules } = await pool.query<DigestSchedule>(
      "SELECT weekday,local_time AS time,timezone FROM ship_live_digest_schedules WHERE workspace_id=$1",
      [id],
    );
    await recheck(principal, id, initial);
    return {
      ...summary,
      ...range,
      workspaceName: initial.workspace.name,
      checkedAt: new Date(time).toISOString(),
      reflection: notes[0]?.reflection ?? "",
      schedule: schedules[0] ?? DEFAULT_DIGEST_SCHEDULE,
    };
  }
  router.get(base, async (req, res) => {
    const principal = await auth.authenticate(req, res);
    res
      .set("Cache-Control", "no-store")
      .json(await read(principal, req.params.id, req.query.week));
  });
  router.get(`${base}/export`, async (req, res) => {
    const principal = await auth.authenticate(req, res);
    const recap = await read(principal, req.params.id, req.query.week);
    res
      .set("Cache-Control", "no-store")
      .set(
        "Content-Disposition",
        `attachment; filename="recap-${recap.weekStart}.md"`,
      )
      .type("text/markdown")
      .send(recapMarkdown(recap));
  });
  router.put(`${base}/reflection`, async (req, res) => {
    const principal = await auth.requireMutation(req, res),
      initial = await viewer(principal, req.params.id),
      range = week(req.body?.week, now());
    const reflection = req.body?.reflection;
    if (typeof reflection !== "string" || reflection.length > 5000)
      throw new AuthError(400, "Keep your reflection within 5,000 characters.");
    await save(
      principal,
      req.params.id,
      initial,
      `INSERT INTO ship_live_recap_notes(workspace_id,user_id,week_start,reflection) VALUES($1,$2,$3::date,$4) ON CONFLICT(workspace_id,user_id,week_start) DO UPDATE SET reflection=EXCLUDED.reflection,updated_at=now()`,
      [req.params.id, principal.user.id, range.weekStart, reflection],
    );
    res.json({ reflection });
  });
  router.put(`${base}/schedule`, async (req, res) => {
    const principal = await auth.requireMutation(req, res),
      initial = await viewer(principal, req.params.id);
    let schedule: DigestSchedule;
    try {
      schedule = parseDigestSchedule(req.body);
    } catch (e) {
      throw new AuthError(400, (e as Error).message);
    }
    // Accept only names supported by the scheduler's own timezone database too.
    const zones = await pool.query(
      "SELECT 1 FROM pg_timezone_names WHERE name=$1",
      [schedule.timezone],
    );
    if (!zones.rowCount)
      throw new AuthError(400, "Choose a supported IANA timezone.");
    await save(
      principal,
      req.params.id,
      initial,
      `INSERT INTO ship_live_digest_schedules(workspace_id,weekday,local_time,timezone) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id) DO UPDATE SET weekday=EXCLUDED.weekday,local_time=EXCLUDED.local_time,timezone=EXCLUDED.timezone,updated_at=now()`,
      [req.params.id, schedule.weekday, schedule.time, schedule.timezone],
    );
    res.json(schedule);
  });
  return router;
}
