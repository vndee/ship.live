export interface DigestSchedule {
  weekday: number;
  time: string;
  timezone: string;
}
export const DEFAULT_DIGEST_SCHEDULE: DigestSchedule = {
  weekday: 1,
  time: "09:00",
  timezone: "UTC",
};
export const RECAP_DAY = 86_400_000;
export function utcMonday(time: number): number {
  const d = new Date(time);
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() - ((d.getUTCDay() + 6) % 7),
  );
}
export function resolveRecapWeek(week?: string, now = Date.now()) {
  const start =
    week === undefined
      ? utcMonday(now) - 7 * RECAP_DAY
      : Date.parse(`${week}T00:00:00Z`);
  if (
    !Number.isFinite(start) ||
    (week !== undefined &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(week) ||
        new Date(start).toISOString().slice(0, 10) !== week)) ||
    utcMonday(start) !== start ||
    start >= utcMonday(now)
  )
    throw new Error("Choose a completed week starting on Monday.");
  return {
    weekStart: new Date(start).toISOString().slice(0, 10),
    weekEnd: new Date(start + 6 * RECAP_DAY).toISOString().slice(0, 10),
  };
}
export function parseDigestSchedule(value: unknown): DigestSchedule {
  if (!value || typeof value !== "object")
    throw new Error("Choose a valid digest schedule.");
  const { weekday, time, timezone } = value as Record<string, unknown>;
  if (
    typeof weekday !== "number" ||
    !Number.isInteger(weekday) ||
    weekday < 0 ||
    weekday > 6 ||
    typeof time !== "string" ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ||
    typeof timezone !== "string" ||
    timezone.length > 100 ||
    /^[+-]/.test(timezone)
  )
    throw new Error("Choose a valid digest day, time, and IANA timezone.");
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
  } catch {
    throw new Error("Choose a valid IANA timezone.");
  }
  return { weekday, time, timezone };
}
export interface Recap {
  workspaceName: string;
  weekStart: string;
  weekEnd: string;
  checkedAt: string;
  totals: {
    merges: number;
    reviews: number;
    releases: number;
    contributors: number;
    xp: number;
  };
  shipped: {
    id: string;
    type: string;
    title: string;
    repository: string;
    number?: number;
    url?: string;
    occurredAt: string;
  }[];
  helpfulReviewers: { login: string; reviews: number; pullRequests: number }[];
  needsHelp: {
    repository: string;
    number: number;
    title: string;
    url: string;
    state: "waiting" | "failing";
  }[];
  reflection: string;
  schedule: DigestSchedule;
}
export function safeRecapUrl(value?: string) {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
export function recapMarkdown(recap: Recap): string {
  const text = (value: string) =>
    value
      .replace(/[\\`*_{}\[\]()#+!|>]/g, "\\$&")
      .replace(/</g, "&lt;")
      .replace(/\r?\n/g, " ");
  const link = (title: string, url?: string) => {
    const safe = safeRecapUrl(url);
    return safe
      ? `[${text(title)}](${safe.replace(/[()]/g, (c) => (c === "(" ? "%28" : "%29"))})`
      : text(title);
  };
  return (
    [
      `# ${text(recap.workspaceName)} — weekly recap`,
      `${recap.weekStart}–${recap.weekEnd} (UTC Monday–Sunday)`,
      "Based on stored activity in your currently authorized repositories. Missing history may lower totals. Highlights are limited to five per section.",
      `${recap.totals.merges} merges · ${recap.totals.reviews} reviews · ${recap.totals.releases} releases · ${recap.totals.contributors} contributors`,
      "## Shipped highlights",
      ...(recap.shipped.length
        ? recap.shipped.map(
            (i) => `- ${text(i.repository)}: ${link(i.title, i.url)}`,
          )
        : ["No merges or releases in stored activity."]),
      "## Helpful reviewers",
      ...(recap.helpfulReviewers.length
        ? recap.helpfulReviewers.map(
            (i) =>
              `- ${text(i.login)}: helped on ${i.pullRequests} PRs (${i.reviews} reviews)`,
          )
        : ["No cross-author reviews confirmed."]),
      "## Current needs help",
      `Latest stored PR status checked ${recap.checkedAt}; this is not a snapshot of the recap week.`,
      ...(recap.needsHelp.length
        ? recap.needsHelp.map(
            (i) =>
              `- ${link(`${i.repository} #${i.number}: ${i.title}`, i.url)} — ${i.state}`,
          )
        : ["No current PRs needing help found."]),
      "## Your reflection (private)",
      text(recap.reflection) || "No reflection added.",
    ].join("\n\n") + "\n"
  );
}
