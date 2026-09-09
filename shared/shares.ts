import type { FeedResponse } from "./types";
import type { EngineeringWallSnapshot } from "./wall";

export const SHARE_DURATIONS = [
  { seconds: 3600, label: "1 hour" },
  { seconds: 21600, label: "6 hours" },
  { seconds: 43200, label: "12 hours" },
  { seconds: 86400, label: "24 hours" },
  { seconds: 259200, label: "3 days" },
  { seconds: 604800, label: "7 days" },
  { seconds: 1209600, label: "14 days" },
  { seconds: 2592000, label: "30 days" },
  { seconds: 7776000, label: "90 days" },
  { seconds: 15552000, label: "180 days" },
  { seconds: 31557600, label: "1 year" },
  { seconds: 157788000, label: "5 years" },
  { seconds: 315576000, label: "10 years" },
  {
    seconds: 3155760000,
    label: "No expiration",
    detail: "100-year link",
  },
] as const;

export const NO_EXPIRATION_SECONDS = 3_155_760_000;

export function shareDurationSummary(seconds: number): string {
  const duration = SHARE_DURATIONS.find((item) => item.seconds === seconds);
  return seconds === NO_EXPIRATION_SECONDS
    ? "This link does not expire."
    : `This link expires in ${duration?.label || "the selected period"}.`;
}

export function isEffectivelyNoExpiration(
  expiresAt: string,
  now = Date.now(),
): boolean {
  return Date.parse(expiresAt) - now >= 50 * 365 * 86_400_000;
}

export function moveShareDuration(
  current: number,
  key: "ArrowUp" | "ArrowDown" | "Home" | "End",
): number {
  const index = Math.max(
    0,
    SHARE_DURATIONS.findIndex((item) => item.seconds === current),
  );
  if (key === "Home") return SHARE_DURATIONS[0].seconds;
  if (key === "End") return SHARE_DURATIONS.at(-1)!.seconds;
  const offset = key === "ArrowDown" ? 1 : -1;
  return SHARE_DURATIONS[
    Math.max(0, Math.min(SHARE_DURATIONS.length - 1, index + offset))
  ].seconds;
}

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
  wall: EngineeringWallSnapshot;
}
