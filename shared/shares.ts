import type { FeedResponse } from "./types";

export const SHARE_DURATIONS = [
  { seconds: 3600, label: "1 hour" },
  { seconds: 86400, label: "24 hours" },
  { seconds: 604800, label: "7 days" },
  { seconds: 2592000, label: "30 days" },
] as const;

export interface DashboardShare {
  id: string;
  createdAt: string;
  expiresAt: string;
  repositoryCount: number;
}
export interface CreatedDashboardShare extends DashboardShare {
  token: string;
}
export interface SharedFeedResponse extends FeedResponse {
  expiresAt: string;
}
