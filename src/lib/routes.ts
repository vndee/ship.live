import { LOGIN } from "../../shared/github-login";
import { ALL_SCENES, type WallScene } from "./engineering-wall";
import { isTag } from "./journal";
import type { ActivityEvent } from "../../shared/types";

export type Page =
  "pulse" | "feed" | "team" | "milestones" | "health" | "webhooks";
export type Period = "24h" | "7d" | "30d";
type Kind = ActivityEvent["type"];

/** Everything a URL can say about the private app. */
export interface Route {
  page: Page;
  /** An explicit workspace must match the authenticated workspace list. */
  workspace?: string;
  scene?: WallScene;
  pulsePeriod?: "today" | "7d" | "30d" | "month" | "custom";
  from?: string;
  to?: string;
  /** Live feed filters; other pages drop them. */
  repo?: string;
  kind?: Kind;
  /** A journal hashtag, without the #. */
  tag?: string;
  query?: string;
  period?: Period;
  /** A contributor profile open over the page. */
  person?: string;
  /** A repository's details open over the page. */
  repository?: string;
}

const PATHS: Record<Page, string> = {
  pulse: "/",
  feed: "/feed",
  team: "/team",
  milestones: "/milestones",
  health: "/health",
  webhooks: "/webhooks",
};
export const PAGE_TITLES: Record<Page, string> = {
  pulse: "Pulse",
  feed: "Live feed",
  team: "Team",
  milestones: "Milestones",
  health: "Service Health",
  webhooks: "Webhooks",
};
const KINDS: readonly Kind[] = [
  "merge",
  "review",
  "push",
  "issue",
  "release",
  "pr",
  "note",
  "alert",
];
const PERIODS: readonly Period[] = ["24h", "7d", "30d"];
// owner/name as GitHub allows it, or a bare name for sources without an owner.
const REPOSITORY = /^[\w.-]{1,100}(?:\/[\w.-]{1,100})?$/;

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
  // Keep even empty or malformed values explicit: authorization fails closed.
  if (params.has("workspace")) route.workspace = params.get("workspace")!;
  if (page === "pulse") {
    const scene = oneOf(ALL_SCENES, params.get("scene"));
    if (scene) route.scene = scene;
  }
  if (page === "feed") {
    const repo = params.get("repo")?.trim();
    if (repo && repo.length <= 200) route.repo = repo;
    const kind = oneOf(KINDS, params.get("type"));
    if (kind) route.kind = kind;
    const tag = params.get("tag")?.toLowerCase().normalize("NFC");
    if (tag && isTag(tag)) route.tag = tag;
    // Kept as typed, spaces included, so the controlled search box never
    // drops a keystroke; filtering trims it.
    const query = params.get("q")?.slice(0, 200);
    if (query) route.query = query;
    const period = oneOf(PERIODS, params.get("period"));
    if (period && period !== "24h") route.period = period;
  }
  if (page === "pulse") {
    const preset = oneOf(
      ["today", "7d", "30d", "month", "custom"] as const,
      params.get("period"),
    );
    if (preset && preset !== "7d") route.pulsePeriod = preset;
  }
  if ((page === "pulse" && route.pulsePeriod === "custom") || page === "feed") {
    // Preserve invalid input for the range UI to explain; never silently widen it.
    if (params.has("from")) route.from = params.get("from")!.slice(0, 32);
    if (params.has("to")) route.to = params.get("to")!.slice(0, 32);
  }
  const person = params.get("person");
  if (person && LOGIN.test(person)) route.person = person;
  const repository = params.get("repository");
  if (repository && REPOSITORY.test(repository)) route.repository = repository;
  return route;
}

export function routeHref(route: Route): string {
  const params = new URLSearchParams();
  if (route.workspace !== undefined) params.set("workspace", route.workspace);
  if (route.page === "pulse" && route.scene) params.set("scene", route.scene);
  if (route.page === "feed") {
    if (route.repo) params.set("repo", route.repo);
    if (route.kind) params.set("type", route.kind);
    if (route.tag) params.set("tag", route.tag);
    if (route.query) params.set("q", route.query);
    if (route.period && route.period !== "24h")
      params.set("period", route.period);
  }
  if (route.page === "pulse" && route.pulsePeriod && route.pulsePeriod !== "7d")
    params.set("period", route.pulsePeriod);
  if (
    (route.page === "pulse" && route.pulsePeriod === "custom") ||
    route.page === "feed"
  ) {
    if (route.from !== undefined) params.set("from", route.from);
    if (route.to !== undefined) params.set("to", route.to);
  }
  if (route.person) params.set("person", route.person);
  if (route.repository) params.set("repository", route.repository);
  const search = params.toString();
  return `${PATHS[route.page]}${search ? `?${search}` : ""}`;
}
