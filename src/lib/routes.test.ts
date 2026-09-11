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
