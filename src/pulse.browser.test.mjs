// Isolated real React components, mocked transport, no external requests.
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright"
);
let browser, bundle;
before(async () => {
  const result = await build({
    stdin: {
      contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {PulseOverview} from './src/components/PulseOverview';
    import {PulseHistoryFeed} from './src/components/PulseHistoryFeed';
    import {usePulseLocation, setPulseLocation} from './src/hooks/usePulse';
    function Harness() {
      const [source, setSource] = useState({workspaceId:'alpha', demo:false, events:[], enabled:true});
      window.changeSource = (update) => setSource(s => ({...s,...update}));
      const loc = usePulseLocation();
      const now = Date.parse('2026-09-15T00:30:00Z');
      return loc.history ? <PulseHistoryFeed source={source} now={now} from={loc.selection.from} to={loc.selection.to} repo={loc.repo} onBack={()=>setPulseLocation(loc.selection)} /> : <PulseOverview source={source} now={now} onHistory={(from,to,repo)=>setPulseLocation({period:'custom',from,to},true,repo)} />;
    }
    createRoot(document.getElementById('root')).render(<Harness/>);
  `,
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"development"' },
  });
  bundle = result.outputFiles[0].text;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  });
});
after(async () => browser?.close());
async function open(t, path = "/") {
  const context = await browser.newContext({
    timezoneId: "America/Los_Angeles",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  t.after(async () => {
    await context.close();
    assert.deepEqual(errors, []);
  });
  await page.route("**/*", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("http://pulse.test" + path);
  await page.evaluate(() => {
    window.requests = [];
    // Deliberately ignore AbortSignal in transport so stale-response checks
    // exercise the component's own guard, even when transport cannot cancel.
    window.fetch = (url, options) =>
      new Promise((resolve) =>
        window.requests.push({
          url,
          headers: options.headers,
          signal: options.signal,
          resolve,
        }),
      );
    window.respond = (index, data, status = 200) =>
      window.requests[index].resolve(
        new Response(JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
  });
  await page.addScriptTag({ content: bundle });
  return page;
}
async function request(page, index) {
  await page.waitForFunction((i) => window.requests.length > i, index);
  return page.evaluate(
    (i) => ({
      url: window.requests[i].url,
      headers: window.requests[i].headers,
    }),
    index,
  );
}
async function respond(page, index, data, status = 200) {
  await page.evaluate(
    ({ index, data, status }) => window.respond(index, data, status),
    { index, data, status },
  );
}
function overview(url, count = 2501) {
  const params = new URL(url, "http://pulse.test").searchParams;
  const from = params.get("from"),
    to = params.get("to");
  return {
    range: { from, to, granularity: "day" },
    totals: { count, merges: 100, reviews: 50, releases: 2 },
    buckets: [{ from, to: from, count }],
    repositories: [{ repo: "org/private", count, merges: 100, reviews: 50 }],
    coverage: { earliestStoredAt: null, retentionDays: null },
  };
}
const row = (id) => ({
  id,
  type: "merge",
  actor: { login: "human" },
  repo: "org/private",
  occurredAt: "2026-09-14T10:00:00Z",
  title: id,
});
async function settle(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}
async function total(page, value) {
  await page.waitForFunction(
    (v) => document.querySelector("[data-pulse-total]")?.textContent === v,
    value,
  );
}

test("remote overview uses full server totals, UTC dates, and exact repository drill-down", async (t) => {
  const page = await open(t);
  const req = await request(page, 0);
  assert.equal(
    req.url,
    "/api/workspaces/alpha/pulse/overview?period=custom&from=2026-09-09&to=2026-09-15",
  );
  await respond(page, 0, overview(req.url));
  await total(page, "2,501");
  await page
    .getByRole("button", { name: "View activity for org/private", exact: true })
    .click();
  const history = await request(page, 1);
  const url = new URL(history.url, "http://pulse.test");
  assert.equal(url.pathname, "/api/workspaces/alpha/pulse/activity");
  assert.equal(url.searchParams.get("from"), "2026-09-09");
  assert.equal(url.searchParams.get("to"), "2026-09-15");
  assert.equal(url.searchParams.get("repo"), "org/private");
});

test("superseded range and workspace responses never restore stale totals; access failure clears results", async (t) => {
  const page = await open(t);
  await request(page, 0);
  await page.getByRole("button", { name: /^Period:/ }).click();
  await page.getByRole("option", { name: "Today", exact: true }).click();
  const today = await request(page, 1);
  assert.match(today.url, /from=2026-09-15&to=2026-09-15$/);
  await respond(page, 1, overview(today.url, 42));
  await total(page, "42");
  await respond(page, 0, overview((await request(page, 0)).url, 9999));
  await settle(page);
  assert.equal(await page.locator("[data-pulse-total]").textContent(), "42");
  await page.evaluate(() => window.changeSource({ workspaceId: "beta" }));
  const beta = await request(page, 2);
  assert.equal(await page.locator("[data-pulse-total]").count(), 0);
  assert.match(beta.url, /workspaces\/beta/);
  await page.evaluate(() => window.changeSource({ workspaceId: "gamma" }));
  const gamma = await request(page, 3);
  await respond(page, 3, overview(gamma.url, 7));
  await total(page, "7");
  await respond(page, 2, overview(beta.url, 8888));
  await settle(page);
  assert.equal(await page.locator("[data-pulse-total]").textContent(), "7");
  await page.evaluate(() => window.changeSource({ revision: "refresh" }));
  await request(page, 4);
  await respond(page, 4, { error: "Access revoked" }, 403);
  await page.getByRole("alert").waitFor();
  assert.equal(await page.locator("[data-pulse-total]").count(), 0);
  assert.equal(await page.getByText("org/private", { exact: true }).count(), 0);
});

test("shared overview and history use share header, retain hash, and append cursor pages", async (t) => {
  const page = await open(t, "/shared#secret-token");
  await page.evaluate(() =>
    window.changeSource({ workspaceId: undefined, shareToken: "secret-token" }),
  );
  const req = await request(page, 0);
  assert.match(req.url, /^\/api\/shared\/pulse\/overview/);
  assert.deepEqual(req.headers, { "x-dashboard-share": "secret-token" });
  await respond(page, 0, overview(req.url));
  await total(page, "2,501");
  await page
    .getByRole("button", { name: "View activity in this period", exact: true })
    .click();
  assert.equal(new URL(page.url()).hash, "#secret-token");
  const first = await request(page, 1);
  assert.match(first.url, /^\/api\/shared\/pulse\/activity/);
  assert.deepEqual(first.headers, req.headers);
  await respond(page, 1, {
    events: [row("first-private")],
    nextCursor: "opaque+/cursor",
  });
  await page.getByText("first-private", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Load more activity" }).click();
  const second = await request(page, 2);
  assert.equal(
    new URL(second.url, "http://pulse.test").searchParams.get("cursor"),
    "opaque+/cursor",
  );
  await respond(page, 2, {
    events: [row("second-private")],
    nextCursor: "next",
  });
  await page.getByText("second-private", { exact: true }).waitFor();
  assert.equal(await page.locator(".event-row").count(), 2);
  await page.getByRole("button", { name: "Load more activity" }).click();
  await request(page, 3);
  await respond(page, 3, { error: "Share revoked" }, 403);
  await page.getByRole("alert").waitFor();
  assert.equal(await page.locator(".event-row").count(), 0);
});

test("history range/scope changes clear rows and ignore old pagination, logout clears rows", async (t) => {
  const page = await open(
    t,
    "/?period=custom&from=2026-09-01&to=2026-09-10&view=activity",
  );
  await request(page, 0);
  await respond(page, 0, { events: [row("old-private")], nextCursor: "next" });
  await page.getByText("old-private", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Load more activity" }).click();
  await request(page, 1);
  await page.evaluate(() => {
    history.pushState(
      null,
      "",
      "/?period=custom&from=2026-09-11&to=2026-09-12&view=activity",
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  const next = await request(page, 2);
  assert.match(next.url, /from=2026-09-11&to=2026-09-12/);
  assert.equal(await page.locator(".event-row").count(), 0);
  await respond(page, 2, {
    events: [row("current-private")],
    nextCursor: null,
  });
  await page.getByText("current-private", { exact: true }).waitFor();
  await respond(page, 1, { events: [row("late-private")], nextCursor: null });
  await settle(page);
  assert.deepEqual(await page.locator(".event-title").allTextContents(), [
    "current-private",
  ]);
  await page.evaluate(() => window.changeSource({ workspaceId: "beta" }));
  await request(page, 3);
  assert.equal(await page.locator(".event-row").count(), 0);
  await respond(page, 3, { events: [row("beta-private")], nextCursor: null });
  await page.getByText("beta-private", { exact: true }).waitFor();
  await page.evaluate(() => window.changeSource({ enabled: false }));
  await page.waitForFunction(() => !document.querySelector(".event-row"));
});

test("live reauthorization preserves loaded historical pages and in-flight pagination", async (t) => {
  const page = await open(
    t,
    "/?period=custom&from=2026-09-01&to=2026-09-15&view=activity",
  );
  await request(page, 0);
  await respond(page, 0, {
    events: [row("first-page")],
    nextCursor: "scope-bound-first-cursor",
  });
  await page.getByText("first-page", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Load more activity" }).click();
  await request(page, 1);
  await respond(page, 1, {
    events: [row("second-page")],
    nextCursor: "third-page-cursor",
  });
  await page.getByText("second-page", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Load more activity" }).click();
  await request(page, 2);
  await page.evaluate(() => window.changeSource({ revision: "live-snapshot" }));
  const probe = await request(page, 3);
  assert.equal(
    new URL(probe.url, "http://pulse.test").searchParams.get("cursor"),
    "scope-bound-first-cursor",
  );
  assert.equal(
    await page.evaluate(() => window.requests[2].signal.aborted),
    false,
    "live refresh must not cancel historical Load more",
  );
  await respond(page, 3, {
    events: [row("second-page")],
    nextCursor: "third-page-cursor",
  });
  await settle(page);
  assert.deepEqual(await page.locator(".event-title").allTextContents(), [
    "first-page",
    "second-page",
  ]);
  await respond(page, 2, { events: [row("third-page")], nextCursor: null });
  await page.getByText("third-page", { exact: true }).waitFor();
  assert.deepEqual(await page.locator(".event-title").allTextContents(), [
    "first-page",
    "second-page",
    "third-page",
  ]);
  await page.evaluate(() =>
    window.changeSource({ revision: "access-removed" }),
  );
  await request(page, 4);
  await respond(page, 4, { error: "Access revoked" }, 403);
  await page.getByRole("alert").waitFor();
  assert.equal(await page.locator(".event-row").count(), 0);
});

test("an older authorization probe cannot clear a successful retry", async (t) => {
  const page = await open(
    t,
    "/?period=custom&from=2026-09-01&to=2026-09-15&view=activity",
  );
  await request(page, 0);
  await respond(page, 0, {
    events: [row("initial")],
    nextCursor: "scope-cursor",
  });
  await page.getByRole("button", { name: "Load more activity" }).click();
  await request(page, 1);
  await page.evaluate(() => window.changeSource({ revision: "pending-probe" }));
  await request(page, 2);
  await respond(page, 1, { error: "Pagination failed" }, 500);
  await page.getByRole("button", { name: "Try again" }).click();
  await request(page, 3);
  await respond(page, 3, { events: [row("fresh-retry")], nextCursor: null });
  await page.getByText("fresh-retry", { exact: true }).waitFor();
  await respond(page, 2, { error: "Old probe failed" }, 500);
  await settle(page);
  assert.deepEqual(await page.locator(".event-title").allTextContents(), [
    "fresh-retry",
  ]);
  assert.equal(await page.getByRole("alert").count(), 0);
});
