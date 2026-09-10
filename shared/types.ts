export type ActivityType =
  "merge" | "review" | "push" | "issue" | "release" | "pr" | "note";

export interface ActivityEvent {
  id: string;
  type: ActivityType;
  actor: { login: string; avatarUrl?: string };
  repo: string;
  title: string;
  url?: string;
  occurredAt: string;
  number?: number;
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
  notice?: string;
}
