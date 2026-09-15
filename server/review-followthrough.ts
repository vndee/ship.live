import { Router } from "express";
import type { Workspace } from "../shared/workspaces.js";
import type { ReviewAction } from "../shared/review-followthrough.js";
import { AuthError, type AuthService, type Principal } from "./auth.js";
import type { PostgresEventStore } from "./postgres-store.js";
import {
  ReviewFollowthroughStore,
  type ReviewScope,
  type ReviewTarget,
} from "./review-followthrough-store.js";
interface Viewer extends ReviewScope {
  workspace: Workspace;
}
const scopeKey = (s: Viewer) =>
  JSON.stringify([
    s.workspace.id,
    s.workspace.kind,
    s.workspace.installationId ?? null,
    s.author ?? null,
    s.sources
      .map((p) => [
        p.installationId,
        p.repositories.map((r) => r.id).sort((a, b) => a - b),
      ])
      .sort((a, b) => Number(a[0]) - Number(b[0])),
  ]);
const valid = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0;
export function reviewFollowthroughRouter({
  auth,
  store,
  viewer,
}: {
  auth: AuthService;
  store: PostgresEventStore;
  viewer: (principal: Principal, id: string) => Promise<Viewer>;
}) {
  const router = Router(),
    reviews = new ReviewFollowthroughStore(store.pool),
    base = "/api/workspaces/:id/review-followthrough";
  async function recheck(p: Principal, initial: Viewer) {
    await auth.assertActive(p);
    const current = await viewer(p, initial.workspace.id);
    if (scopeKey(current) !== scopeKey(initial))
      throw new AuthError(
        403,
        "Repository access changed. Refresh your dashboard.",
      );
  }
  router.get(base, async (req, res) => {
    const principal = await auth.authenticate(req, res);
    const initial = await viewer(principal, req.params.id);
    const raw = typeof req.query.items === "string" ? req.query.items : "";
    const tokens = raw.split(",");
    if (
      !raw ||
      raw.length > 2000 ||
      tokens.length > 50 ||
      tokens.some((t) => !/^\d+:\d+$/.test(t))
    )
      throw new AuthError(400, "Choose up to 50 pull requests.");
    const targets = [...new Set(tokens)].map((t) => {
      const [repositoryId, number] = t.split(":").map(Number);
      return { repositoryId, number };
    });
    if (targets.some((t) => !valid(t.repositoryId) || !valid(t.number)))
      throw new AuthError(400, "Invalid pull request.");
    const items = await reviews.states(
      initial.workspace.id,
      principal.user.id,
      await reviews.current(initial, targets),
    );
    await recheck(principal, initial);
    res.set("Cache-Control", "no-store").json({ items, current: true });
  });
  router.post(base, async (req, res) => {
    const principal = await auth.requireMutation(req, res),
      initial = await viewer(principal, req.params.id);
    const { repositoryId, number, fingerprint, action, hours } = req.body ?? {};
    if (
      !valid(repositoryId) ||
      !valid(number) ||
      typeof fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(fingerprint) ||
      !["claim", "release", "snooze", "unsnooze"].includes(action) ||
      (action === "snooze" && ![1, 4, 24].includes(hours))
    )
      throw new AuthError(400, "Choose a valid review action.");
    const target: ReviewTarget = { repositoryId, number };
    const item = (await reviews.current(initial, [target]))[0];
    if (!item)
      throw new AuthError(404, "This pull request is no longer available.");
    if (item.fingerprint !== fingerprint || !item.actionable)
      throw new AuthError(
        409,
        "This pull request changed. Refresh its current status.",
      );
    await recheck(principal, initial);
    await reviews.mutate(
      initial.workspace.id,
      principal.user.id,
      item,
      action as ReviewAction,
      hours,
      initial,
    );
    const current = (await reviews.current(initial, [target]))[0];
    await recheck(principal, initial);
    if (!current || current.fingerprint !== fingerprint)
      throw new AuthError(
        409,
        "This pull request changed. Refresh its current status.",
      );
    const items = await reviews.states(
      initial.workspace.id,
      principal.user.id,
      [current],
    );
    await recheck(principal, initial);
    res.set("Cache-Control", "no-store").json({ items, current: true });
  });
  return router;
}
