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
