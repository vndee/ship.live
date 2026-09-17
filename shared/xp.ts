import type { ActivityEvent } from "./types.js";
import type { PipelineState, ReviewState } from "./wall.js";

/** Observations frozen at live merge ingestion, not a code-quality assessment. */
export interface MergeVerification {
  version: 2;
  capturedAt: string;
  headSha?: string;
  peerReview: { status: "observed" | "unknown"; reviewIds: number[] };
  ci: { status: "passing" | "not_passing" | "unknown"; checkIds: string[] };
}

const identity = (login: string) => login.trim().toLowerCase();
const human = (login: string) =>
  Boolean(identity(login)) &&
  !/\[bot\]$|-bot$/i.test(identity(login)) &&
  !["dependabot", "renovate", "github-actions"].includes(identity(login));

export function mergeVerification(
  event: ActivityEvent,
  reviews: ReviewState[],
  pipelines: PipelineState[],
  capturedAt: string,
): MergeVerification {
  const cutoff = Date.parse(event.occurredAt);
  const beforeMerge = (date: string) =>
    Number.isFinite(Date.parse(date)) && Date.parse(date) <= cutoff;
  const latestReviews = new Map<string, ReviewState>();
  for (const r of reviews) {
    if (
      r.pullRequestNumber !== event.number ||
      !human(r.reviewer) ||
      identity(r.reviewer) === identity(event.actor.login)
    )
      continue;
    const previous = latestReviews.get(identity(r.reviewer));
    if (
      !previous ||
      Date.parse(r.submittedAt) > Date.parse(previous.submittedAt) ||
      (r.submittedAt === previous.submittedAt && r.id > previous.id)
    )
      latestReviews.set(identity(r.reviewer), r);
  }
  const reviewIds = [...latestReviews.values()]
    .filter(
      (r) =>
        beforeMerge(r.submittedAt) &&
        ["approved", "commented", "changes_requested"].includes(r.decision),
    )
    .map((r) => r.id)
    .sort((a, b) => a - b);
  const latestChecks = new Map<string, PipelineState>();
  for (const check of pipelines) {
    if (!event.headSha || check.headSha !== event.headSha) continue;
    // Distinct check IDs may be independent jobs with the same name.
    const key = check.id;
    const previous = latestChecks.get(key);
    if (
      !previous ||
      Date.parse(check.updatedAt) > Date.parse(previous.updatedAt) ||
      (check.updatedAt === previous.updatedAt && check.id > previous.id)
    )
      latestChecks.set(key, check);
  }
  const checks = [...latestChecks.values()];
  const known =
    checks.length > 0 &&
    checks.every(
      (c) =>
        beforeMerge(c.updatedAt) &&
        (!c.completedAt || beforeMerge(c.completedAt)),
    );
  return {
    version: 2,
    capturedAt,
    ...(event.headSha ? { headSha: event.headSha } : {}),
    peerReview: {
      status: reviewIds.length ? "observed" : "unknown",
      reviewIds,
    },
    ci: {
      status: !known
        ? "unknown"
        : checks.every((c) => c.status === "passing")
          ? "passing"
          : "not_passing",
      checkIds: known ? checks.map((c) => c.id).sort() : [],
    },
  };
}

/** Candidate bonuses stay outside ranked XP until repository coverage is audited. */
export function candidateVerificationBonus(value: MergeVerification): number {
  return (
    (value.peerReview.status === "observed" ? 5 : 0) +
    (value.ci.status === "passing" ? 5 : 0)
  );
}
