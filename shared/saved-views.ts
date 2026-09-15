import { resolvePulseRange } from "./pulse.js";
import { LOGIN } from "./github-login.js";
export interface SavedViewInput {
  name: string;
  href: string;
  workspaceId: string;
}
export interface SavedView extends SavedViewInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scenes = [
  "pulse",
  "review",
  "release",
  "delivery",
  "health",
  "leaderboard",
];
const kinds = [
  "merge",
  "review",
  "release",
  "push",
  "issue",
  "pr",
  "note",
  "alert",
  "contribution",
];
/** Store navigation only. Permission to open its workspace is checked afresh. */
export function normalizeSavedView(
  input: unknown,
  now = Date.now(),
): SavedViewInput {
  if (!input || typeof input !== "object")
    throw new Error("Choose a name and view to save.");
  const { name, href } = input as Record<string, unknown>;
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.trim().length > 60 ||
    /[\u0000-\u001f\u007f]/.test(name)
  )
    throw new Error("Use a view name of 1–60 characters.");
  if (
    typeof href !== "string" ||
    href.length > 2048 ||
    !/^\/(?!\/)/.test(href) ||
    /[\\\u0000-\u0020\u007f]/.test(href)
  )
    throw new Error("Choose a valid internal view.");
  const url = new URL(href, "https://view.invalid");
  const path = url.pathname;
  if (
    ![
      "/",
      "/feed",
      "/team",
      "/milestones",
      "/health",
      "/webhooks",
      "/recap",
    ].includes(path) ||
    url.hash
  )
    throw new Error("This page cannot be saved.");
  const source = url.searchParams,
    params = new URLSearchParams();
  const workspace = source.get("workspace");
  if (
    !workspace ||
    !UUID.test(workspace) ||
    source.getAll("workspace").length !== 1
  )
    throw new Error("Choose an accessible workspace first.");
  params.set("workspace", workspace);
  const keep = (key: string, max = 200) => {
    const value = source.get(key);
    if (value && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value))
      params.set(key, value);
  };
  if (path === "/") {
    keep("env");
    const scene = source.get("scene");
    if (scene && scenes.includes(scene)) params.set("scene", scene);
    const period = source.get("period") || "7d";
    if (!["today", "7d", "30d", "month", "custom"].includes(period))
      throw new Error("Choose a valid period.");
    params.set("period", period);
    if (period === "custom") {
      const range = resolvePulseRange(
        {
          period: "custom",
          from: source.get("from") || "",
          to: source.get("to") || "",
        },
        now,
      );
      params.set("from", range.from);
      params.set("to", range.to);
    }
  }
  if (path === "/feed") {
    keep("repo");
    const kind = source.get("type");
    if (kind && kinds.includes(kind)) params.set("type", kind);
    keep("tag", 40);
    keep("q");
    if (source.has("from") || source.has("to")) {
      const range = resolvePulseRange(
        {
          period: "custom",
          from: source.get("from") || "",
          to: source.get("to") || "",
        },
        now,
      );
      params.set("from", range.from);
      params.set("to", range.to);
    } else {
      const period = source.get("period") || "24h";
      if (!["24h", "7d", "30d"].includes(period))
        throw new Error("Choose a valid period.");
      params.set("period", period);
    }
  }
  if (path === "/recap" && source.has("week")) {
    const week = source.get("week")!;
    const range = resolvePulseRange(
      { period: "custom", from: week, to: week },
      now,
    );
    if (new Date(range.start).getUTCDay() !== 1)
      throw new Error("Choose a Monday for the recap week.");
    params.set("week", week);
  }
  const person = source.get("person");
  if (person && LOGIN.test(person)) params.set("person", person);
  const repository = source.get("repository");
  if (repository && /^[\w.-]{1,100}(?:\/[\w.-]{1,100})?$/.test(repository))
    params.set("repository", repository);
  return {
    name: name.trim(),
    href: `${path}?${params}`,
    workspaceId: workspace,
  };
}
export function savedViewPeriodLabel(href: string): string {
  const url = new URL(href, "https://view.invalid"),
    p = url.searchParams;
  if (p.has("from") && p.has("to"))
    return `${p.get("from")} – ${p.get("to")} · fixed UTC dates`;
  if (url.pathname === "/recap")
    return p.has("week")
      ? `Week of ${p.get("week")} · fixed UTC week`
      : "Latest completed week";
  if (url.pathname !== "/" && url.pathname !== "/feed") return "Current view";
  return (
    (
      {
        today: "Today · updates daily",
        "7d": "Rolling last 7 days",
        "30d": "Rolling last 30 days",
        month: "This calendar month",
        "24h": "Rolling last 24 hours",
      } as Record<string, string>
    )[p.get("period") || (url.pathname === "/" ? "7d" : "24h")] ||
    "Custom period"
  );
}
