/** A login continuation is navigation only, limited to the root dashboard. */
export function dashboardReturnTo(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    !/^\/(?:\?|$)/.test(value) ||
    /[\\\u0000-\u0020\u007f]/.test(value)
  )
    return "/";
  const url = new URL(value, "https://dashboard.invalid");
  if (
    url.pathname !== "/" ||
    url.hash ||
    [...url.searchParams.values()].some((value) =>
      /[\\\u0000-\u001f\u007f]/.test(value),
    )
  )
    return "/";
  const input = url.searchParams;
  const output = new URLSearchParams();
  if (input.has("workspace")) output.set("workspace", input.get("workspace")!);
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
  const period = input.get("period");
  if (period && ["today", "7d", "30d", "month", "custom"].includes(period)) {
    if (period !== "7d") output.set("period", period);
    if (period === "custom") {
      // Retain invalid dates for the dashboard's range validation, never widen silently.
      for (const key of ["from", "to"])
        if (input.has(key)) output.set(key, input.get(key)!.slice(0, 32));
    }
  }
  const query = output.toString();
  return query ? `/?${query}` : "/";
}
