import type { ActivityEvent } from "../../shared/types";

export type Page = "pulse" | "feed" | "team" | "milestones" | "health";
export type Period = "24h" | "7d" | "30d";
type Kind = ActivityEvent["type"];

/** Everything a URL can say about the private app. */
export interface Route {
  page: Page;
  /** Live feed filters; other pages drop them. */
  repo?: string;
  kind?: Kind;
  query?: string;
  period?: Period;
  /** A contributor profile open over the page. */
  person?: string;
}

const PATHS: Record<Page, string> = {
  pulse: "/",
  feed: "/feed",
  team: "/team",
  milestones: "/milestones",
  health: "/health",
};
export const PAGE_TITLES: Record<Page, string> = {
  pulse: "Pulse",
  feed: "Live feed",
  team: "Team",
  milestones: "Milestones",
  health: "Service Health",
};
const KINDS: readonly Kind[] = [
  "merge",
  "review",
  "push",
  "issue",
  "release",
  "pr",
  "note",
];
const PERIODS: readonly Period[] = ["24h", "7d", "30d"];
// GitHub logins, including app accounts such as dependabot[bot].
const LOGIN = /^[A-Za-z\d](?:[A-Za-z\d-]{0,38})(?:\[bot\])?$/;

function oneOf<T extends string>(
  values: readonly T[],
  value: string | null,
): T | undefined {
  return values.find((item) => item === value);
}

/** Unknown paths show Pulse; unknown or malformed parameters are ignored. */
export function parseRoute(pathname: string, search: string): Route {
  const path = pathname.replace(/\/+$/, "") || "/";
  const page =
    (Object.keys(PATHS) as Page[]).find((key) => PATHS[key] === path) ??
    "pulse";
  const params = new URLSearchParams(search);
  const route: Route = { page };
  if (page === "feed") {
    const repo = params.get("repo")?.trim();
    if (repo && repo.length <= 200) route.repo = repo;
    const kind = oneOf(KINDS, params.get("type"));
    if (kind) route.kind = kind;
    const query = params.get("q")?.slice(0, 200);
    if (query?.trim()) route.query = query;
    const period = oneOf(PERIODS, params.get("period"));
    if (period && period !== "24h") route.period = period;
  }
  const person = params.get("person");
  if (person && LOGIN.test(person)) route.person = person;
  return route;
}

export function routeHref(route: Route): string {
  const params = new URLSearchParams();
  if (route.page === "feed") {
    if (route.repo) params.set("repo", route.repo);
    if (route.kind) params.set("type", route.kind);
    if (route.query) params.set("q", route.query);
    if (route.period && route.period !== "24h")
      params.set("period", route.period);
  }
  if (route.person) params.set("person", route.person);
  const search = params.toString();
  return `${PATHS[route.page]}${search ? `?${search}` : ""}`;
}
