import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Pool } from "pg";
import { AuthError, type AuthService, type Principal } from "./auth.js";
import { normalizeSavedView, type SavedView } from "../shared/saved-views.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface Row {
  id: string;
  user_id: string;
  workspace_id: string;
  name: string;
  href: string;
  created_at: Date;
  updated_at: Date;
}
const view = (r: Row): SavedView => ({
  id: r.id,
  workspaceId: r.workspace_id,
  name: r.name,
  href: r.href,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});
export function savedViewsRouter({
  auth,
  store,
  viewer,
}: {
  auth: AuthService;
  store: { pool: Pool };
  viewer: (principal: Principal, id: string) => Promise<unknown>;
}) {
  const router = Router(),
    base = "/api/saved-views",
    pool = store.pool;
  router.get(base, async (req, res) => {
    const principal = await auth.authenticate(req, res);
    const { rows } = await pool.query<Row>(
      "SELECT * FROM ship_live_saved_views WHERE user_id=$1 ORDER BY created_at,id LIMIT 30",
      [principal.user.id],
    );
    await auth.assertActive(principal);
    res.json({ views: rows.map(view) });
  });
  const parse = (input: unknown) => {
    try {
      return normalizeSavedView(input);
    } catch (error) {
      throw new AuthError(
        400,
        error instanceof Error ? error.message : "Choose a valid view.",
      );
    }
  };
  const existing = async (userId: string, id: string) => {
    if (!UUID.test(id)) throw new AuthError(404, "Saved view not found.");
    const { rows } = await pool.query<Row>(
      "SELECT * FROM ship_live_saved_views WHERE user_id=$1 AND id=$2",
      [userId, id],
    );
    if (!rows[0]) throw new AuthError(404, "Saved view not found.");
    return rows[0];
  };
  router.post(base, async (req, res) => {
    const principal = await auth.requireMutation(req, res),
      input = parse(req.body);
    await viewer(principal, input.workspaceId);
    const client = await pool.connect();
    let saved: Row;
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT id FROM ship_live_auth_users WHERE id=$1 FOR UPDATE",
        [principal.user.id],
      );
      const count = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM ship_live_saved_views WHERE user_id=$1",
        [principal.user.id],
      );
      if (count.rows[0].count >= 30)
        throw new AuthError(
          409,
          "You can save up to 30 views. Delete a view before adding another.",
        );
      const { rows } = await client.query<Row>(
        "INSERT INTO ship_live_saved_views(id,user_id,workspace_id,name,href) VALUES($1,$2,$3,$4,$5) RETURNING *",
        [
          randomUUID(),
          principal.user.id,
          input.workspaceId,
          input.name,
          input.href,
        ],
      );
      await client.query("COMMIT");
      saved = rows[0];
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await auth.assertActive(principal);
    await viewer(principal, input.workspaceId);
    res.status(201).json(view(saved));
  });
  router.patch(`${base}/:viewId`, async (req, res) => {
    const principal = await auth.requireMutation(req, res),
      old = await existing(principal.user.id, req.params.viewId);
    const input = parse({
      name: req.body?.name ?? old.name,
      href: req.body?.href ?? old.href,
    });
    await viewer(principal, input.workspaceId);
    const { rows } = await pool.query<Row>(
      "UPDATE ship_live_saved_views SET name=$3,href=$4,workspace_id=$5,updated_at=now() WHERE user_id=$1 AND id=$2 RETURNING *",
      [principal.user.id, old.id, input.name, input.href, input.workspaceId],
    );
    if (!rows[0]) throw new AuthError(404, "Saved view not found.");
    await auth.assertActive(principal);
    res.json(view(rows[0]));
  });
  router.delete(`${base}/:viewId`, async (req, res) => {
    const principal = await auth.requireMutation(req, res),
      old = await existing(principal.user.id, req.params.viewId);
    await pool.query(
      "DELETE FROM ship_live_saved_views WHERE user_id=$1 AND id=$2",
      [principal.user.id, old.id],
    );
    res.sendStatus(204);
  });
  return router;
}
