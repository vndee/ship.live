import assert from "node:assert/strict";
import test from "node:test";
import { parseRoute, routeHref, type Route } from "./routes";

test("each page has its own path, and unknown paths show Pulse", () => {
  assert.deepEqual(parseRoute("/", ""), { page: "pulse" });
  assert.deepEqual(parseRoute("/health/", ""), { page: "health" });
  assert.deepEqual(parseRoute("/team", ""), { page: "team" });
  assert.deepEqual(parseRoute("/milestones", ""), { page: "milestones" });
  assert.deepEqual(parseRoute("/webhooks", ""), { page: "webhooks" });
  assert.deepEqual(parseRoute("/pulse", ""), { page: "pulse" });
  assert.deepEqual(parseRoute("/nowhere", "?repo=a/b"), { page: "pulse" });
});

test("live feed filters round-trip through the URL", () => {
  const route: Route = {
    page: "feed",
    repo: "acme/api gateway",
    kind: "merge",
    query: "fix #12 & ship",
    period: "7d",
    person: "sarahpark",
  };
  const href = routeHref(route);
  assert.equal(
    href,
    "/feed?repo=acme%2Fapi+gateway&type=merge&q=fix+%2312+%26+ship&period=7d&person=sarahpark",
  );
  const url = new URL(href, "https://ship.example.test");
  assert.deepEqual(parseRoute(url.pathname, url.search), route);
});

test("filters apply only to the feed, and defaults stay out of the URL", () => {
  assert.equal(
    routeHref({ page: "team", repo: "acme/api", kind: "merge" }),
    "/team",
  );
  assert.equal(routeHref({ page: "feed", period: "24h" }), "/feed");
  assert.deepEqual(parseRoute("/team", "?repo=acme/api&type=merge"), {
    page: "team",
  });
  assert.deepEqual(parseRoute("/", "?person=alexchen"), {
    page: "pulse",
    person: "alexchen",
  });
});

test("search text round-trips exactly as typed, even a leading space", () => {
  for (const query of [" ", "  fix ", "a&b=c"]) {
    const url = new URL(
      routeHref({ page: "feed", query }),
      "https://ship.example.test",
    );
    assert.equal(parseRoute(url.pathname, url.search).query, query);
  }
});

test("malformed parameters are ignored", () => {
  assert.deepEqual(
    parseRoute(
      "/feed",
      `?type=deploy&period=90d&repo=${"x".repeat(201)}&person=<script>`,
    ),
    { page: "feed" },
  );
  assert.deepEqual(parseRoute("/", "?person=dependabot[bot]"), {
    page: "pulse",
    person: "dependabot[bot]",
  });
  assert.equal(parseRoute("/", "?person=-leading").person, undefined);
});

test("a journal tag filters the Live feed and survives the URL", () => {
  assert.equal(routeHref({ page: "feed", tag: "launch" }), "/feed?tag=launch");
  assert.deepEqual(parseRoute("/feed", "?tag=Tiếng-Việt"), {
    page: "feed",
    tag: "tiếng-việt",
  });
  assert.deepEqual(parseRoute("/feed", "?tag=%23bad%20tag"), { page: "feed" });
  assert.deepEqual(
    parseRoute("/feed", `?tag=${encodeURIComponent("İstanbul")}`),
    {
      page: "feed",
      tag: "İstanbul".toLowerCase(),
    },
  );
  assert.deepEqual(parseRoute("/team", "?tag=launch"), { page: "team" });
});

test("a repository's details open over any page and survive the URL", () => {
  const href = routeHref({ page: "team", repository: "acme/api-gateway" });
  assert.equal(href, "/team?repository=acme%2Fapi-gateway");
  const url = new URL(href, "https://ship.example.test");
  assert.deepEqual(parseRoute(url.pathname, url.search), {
    page: "team",
    repository: "acme/api-gateway",
  });
  assert.deepEqual(parseRoute("/", "?repository=platform"), {
    page: "pulse",
    repository: "platform",
  });
  for (const bad of ["a/b/c", "<script>", "acme/", "x".repeat(101)])
    assert.deepEqual(
      parseRoute("/", `?repository=${encodeURIComponent(bad)}`),
      { page: "pulse" },
    );
});

test("Pulse presets and custom calendar dates round trip without changing rolling feed URLs", () => {
  assert.equal(
    routeHref({ page: "pulse", pulsePeriod: "30d" }),
    "/?period=30d",
  );
  assert.equal(routeHref({ page: "pulse", pulsePeriod: "7d" }), "/");
  const route: Route = {
    page: "pulse",
    pulsePeriod: "custom",
    from: "2026-09-01",
    to: "2026-09-10",
  };
  const url = new URL(routeHref(route), "http://ship.test");
  assert.deepEqual(parseRoute(url.pathname, url.search), route);
  assert.deepEqual(
    parseRoute("/feed", "?from=2026-09-01&to=2026-09-10&repo=acme%2Fapi"),
    { page: "feed", repo: "acme/api", from: "2026-09-01", to: "2026-09-10" },
  );
  assert.equal(routeHref({ page: "feed", period: "7d" }), "/feed?period=7d");
});

test("calendar range fields are retained for validation but never leak to other pages", () => {
  assert.deepEqual(
    parseRoute("/", "?period=custom&from=2026-02-30&to=2026-03-01"),
    {
      page: "pulse",
      pulsePeriod: "custom",
      from: "2026-02-30",
      to: "2026-03-01",
    },
  );
  assert.deepEqual(
    parseRoute("/team", "?from=2026-09-01&to=2026-09-10&period=month"),
    { page: "team" },
  );
  assert.equal(
    routeHref({
      page: "team",
      from: "2026-09-01",
      to: "2026-09-10",
      pulsePeriod: "month",
    }),
    "/team",
  );
});

test("digest links retain workspace, calendar range and scene through overlays", () => {
  const route = parseRoute(
    "/",
    "?workspace=team-a&period=custom&from=2026-09-07&to=2026-09-13&scene=review&person=alice",
  );
  assert.equal(route.workspace, "team-a");
  assert.equal(route.scene, "review");
  assert.equal(
    routeHref({ ...route, person: undefined }),
    "/?workspace=team-a&scene=review&period=custom&from=2026-09-07&to=2026-09-13",
  );
});

test("only dashboard scenes are parsed; explicit workspace parameters never become implicit fallbacks", () => {
  assert.equal(parseRoute("/", "?scene=admin").scene, undefined);
  assert.equal(parseRoute("/team", "?scene=review").scene, undefined);
  assert.equal(parseRoute("/", "?workspace=").workspace, "");
  assert.equal(
    parseRoute("/", "?workspace=unknown%2Fworkspace").workspace,
    "unknown/workspace",
  );
});

test("weekly recap URLs retain workspace and explicit week", () => {
  const route = parseRoute("/recap", "?workspace=team-a&week=2026-09-07");
  assert.deepEqual(route, {
    page: "recap",
    workspace: "team-a",
    week: "2026-09-07",
  });
  assert.equal(routeHref(route), "/recap?workspace=team-a&week=2026-09-07");
});

test("Delivery environment survives dashboard navigation and clears outside Pulse", () => {
  const route: Route = {
    page: "pulse",
    scene: "delivery",
    environment: "Preview / EU",
    pulsePeriod: "30d",
  };
  const href = routeHref(route);
  assert.equal(href, "/?scene=delivery&env=Preview+%2F+EU&period=30d");
  const url = new URL(href, "http://ship.test");
  assert.deepEqual(parseRoute(url.pathname, url.search), route);
  assert.equal(parseRoute("/team", "?env=production").environment, undefined);
  assert.equal(routeHref({ page: "team", environment: "production" }), "/team");
  assert.equal(parseRoute("/", "?env=%00private").environment, undefined);
});
