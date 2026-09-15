import type { WallRepositorySnapshot } from "./wall.js";
export interface ReviewFollowthroughItem {
  repositoryId: number;
  number: number;
  fingerprint: string;
  reasons: string[];
  actionable: boolean;
  ageMs: number;
  inactiveMs: number;
  claim?: { userId: string; name: string; expiresAt: string };
  snoozedUntil?: string;
}
export interface ReviewContext {
  workspaceId: string;
  csrfToken: string;
  userId: string;
  scopeKey: string;
}
export type ReviewAction = "claim" | "release" | "snooze" | "unsnooze";
/** Only recorded facts: GitHub's requested-reviewer list is not available here. */
export function reviewFollowthrough(
  repo: WallRepositorySnapshot,
  number: number,
  now = Date.now(),
): ReviewFollowthroughItem | null {
  const pull = repo.pullRequests.find((p) => p.number === number);
  if (!pull || pull.state !== "open" || pull.draft) return null;
  const reviews = new Map<string, (typeof repo.reviews)[number]>();
  for (const r of repo.reviews.filter((r) => r.pullRequestNumber === number)) {
    const prior = reviews.get(r.reviewer.toLowerCase());
    if (!prior || Date.parse(prior.submittedAt) <= Date.parse(r.submittedAt))
      reviews.set(r.reviewer.toLowerCase(), r);
  }
  const checks = new Map<string, (typeof repo.pipelines)[number]>();
  for (const c of repo.pipelines.filter((c) => c.headSha === pull.headSha)) {
    const key = `${c.provider}:${c.name}`;
    const prior = checks.get(key);
    if (!prior || Date.parse(prior.updatedAt) <= Date.parse(c.updatedAt))
      checks.set(key, c);
  }
  const decisions = [...reviews.values()].sort((a, b) =>
    a.reviewer.localeCompare(b.reviewer),
  );
  const pipelines = [...checks.values()].sort((a, b) =>
    `${a.provider}:${a.name}`.localeCompare(`${b.provider}:${b.name}`),
  );
  const reasons: string[] = [];
  if (pipelines.some((c) => c.status === "failing")) reasons.push("CI failing");
  if (decisions.some((r) => r.decision === "changes_requested"))
    reasons.push("Changes requested");
  else if (!decisions.some((r) => r.decision === "approved"))
    reasons.push("No approval recorded");
  if (pull.mergeable === false) reasons.push("Merge conflict");
  if (!pipelines.length) reasons.push("Checks unavailable");
  else if (
    pipelines.some((c) => c.status === "queued" || c.status === "running")
  )
    reasons.push("Checks running");
  else if (
    pipelines.some((c) => c.status === "cancelled" || c.status === "neutral")
  )
    reasons.push("Check result needs attention");
  const latest = Math.max(
    Date.parse(pull.updatedAt),
    ...decisions.map((r) => Date.parse(r.submittedAt)),
    ...pipelines.map((c) => Date.parse(c.updatedAt)),
  );
  return {
    repositoryId: repo.repositoryId,
    number,
    fingerprint: JSON.stringify([
      pull.headSha,
      pull.updatedAt,
      pull.mergeable ?? null,
      decisions.map((r) => [r.id, r.decision, r.submittedAt]),
      pipelines.map((c) => [c.id, c.status, c.updatedAt]),
    ]),
    reasons,
    actionable: reasons.length > 0,
    ageMs: Math.max(0, now - Date.parse(pull.createdAt)),
    inactiveMs: Math.max(0, now - latest),
  };
}
