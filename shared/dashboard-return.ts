import { LOGIN } from "./github-login.js";

/** A login continuation is navigation only, limited to the dashboard and weekly recap. */
export function dashboardReturnTo(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    !/^\/(?:recap)?(?:\?|$)/.test(value) ||
    /[\\\u0000-\u0020\u007f]/.test(value)
  )
    return "/";
  const url = new URL(value, "https://dashboard.invalid");
  if (
    !["/", "/recap"].includes(url.pathname) ||
    url.hash ||
    [...url.searchParams.values()].some((value) =>
      /[\\\u0000-\u001f\u007f]/.test(value),
    )
  )
    return "/";
  const input = url.searchParams;
  const output = new URLSearchParams();
  if (input.has("workspace")) output.set("workspace", input.get("workspace")!);
  if (url.pathname === "/recap") {
    if (input.has("week")) output.set("week", input.get("week")!.slice(0, 32));
    const query = output.toString();
    return `/recap${query ? `?${query}` : ""}`;
  }
  const scene = input.get("scene");
  if (
    scene &&
    [
      "pulse",
      "review",
      "release",
      "delivery",
      "health",
      "leaderboard",
    ].includes(scene)
  )
    output.set("scene", scene);
  const environment = input.get("env");
  if (environment && environment.length <= 200) output.set("env", environment);
  const period = input.get("period");
  if (period && ["today", "7d", "30d", "month", "custom"].includes(period)) {
    if (period !== "7d") output.set("period", period);
    if (period === "custom") {
      // Retain invalid dates for the dashboard's range validation, never widen silently.
      for (const key of ["from", "to"])
        if (input.has(key)) output.set(key, input.get(key)!.slice(0, 32));
    }
  }
  const person = input.get("person");
  if (person && LOGIN.test(person)) output.set("person", person);
  const query = output.toString();
  return query ? `/?${query}` : "/";
}
