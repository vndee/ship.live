import type { Period } from "./routes";

export const PERIOD_NAMES: Record<Period, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

/** Display names for the fictional demo team; real workspaces show GitHub logins. */
const DEMO_NAMES: Record<string, string> = {
  alexchen: "Alex Chen",
  sarahpark: "Sarah Park",
  minhnguyen: "Minh Nguyen",
  emmarivera: "Emma Rivera",
  jordanlee: "Jordan Lee",
  leowang: "Leo Wang",
};
export const personName = (login: string, demo: boolean) =>
  demo ? DEMO_NAMES[login] || login : login;

export const shortRepo = (repo: string) =>
  repo === "journal/notes" ? "Ship notes" : repo.split("/").pop() || repo;

/** Only GitHub HTTPS links leave the app. */
export function safeUrl(url?: string) {
  try {
    const parsed = new URL(url || "");
    return parsed.protocol === "https:" && parsed.hostname === "github.com"
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function ago(timestamp: string, now = Date.now()) {
  const minutes = Math.max(
    0,
    Math.floor((now - Date.parse(timestamp)) / 60000),
  );
  return minutes < 1
    ? "just now"
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : `${Math.floor(minutes / 1440)}d ago`;
}

export function clock(timestamp: number, period: Period) {
  return new Date(timestamp).toLocaleString(
    undefined,
    period === "24h"
      ? { hour: "2-digit", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
  );
}
