export type ActivityType =
  "merge" | "review" | "push" | "issue" | "release" | "pr";

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
}

export interface FeedResponse {
  events: ActivityEvent[];
  organization: string;
  source: "github" | "demo";
  updatedAt: string;
  notice?: string;
}
