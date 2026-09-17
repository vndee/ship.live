import type { MergeVerification } from "./xp.js";
export type ActivityType =
  | "merge"
  | "review"
  | "push"
  | "issue"
  | "release"
  | "pr"
  | "note"
  /** An inbound webhook's accepted request, shown in a team's Live activity. */
  | "alert";

export interface ActivityEvent {
  id: string;
  type: ActivityType;
  actor: { login: string; avatarUrl?: string };
  repo: string;
  title: string;
  url?: string;
  occurredAt: string;
  number?: number;
  /** PR author supplied by GitHub, or resolved from retained PR context. */
  pullRequestAuthor?: string;
  /** Server-resolved eligibility over retained history, before date/feed limits. */
  reviewCredit?: boolean;
  /** Head commit at merge, used only for matching observed checks. */
  headSha?: string;
  verification?: MergeVerification;
  additions?: number;
  deletions?: number;
  /** The base branch a pull request merged into. */
  branch?: string;
  /** Whether `branch` is the repository default, when GitHub reported it. */
  defaultBranch?: boolean;
  /** Commits a branch push added to the repository for the first time. */
  commits?: number;
  body?: string;
  repositoryId?: number;
}

export interface FeedResponse {
  events: ActivityEvent[];
  organization: string;
  source: "github" | "demo" | "workspace";
  updatedAt: string;
  /** Opaque authorized scope identity; activity updates do not change it. */
  accessScope?: string;
  notice?: string;
}
