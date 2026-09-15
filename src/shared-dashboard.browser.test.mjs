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
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {SharedDashboard} from './src/components/SharedDashboard';createRoot(document.getElementById('root')).render(<SharedDashboard/>);`,
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

test("shared comparison drilldowns preserve their kind and period through URL reloads", async (t) => {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, []);
  });
  await page.route("**/*", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.addInitScript(() => {
    const range = (from, to) => ({
      from,
      to,
      start: from + "T00:00:00.000Z",
      end: new Date(Date.parse(to) + 86400000).toISOString(),
      granularity: "day",
    });
    const coverage = { earliestStoredAt: null, retentionDays: null };
    const totals = { count: 3, merges: 1, reviews: 1, releases: 1 };
    const events = ["merge", "review", "release"].flatMap((type) =>
      ["2026-09-10", "2026-09-03"].map((date) => ({
        id: type + date,
        type,
        actor: { login: "alice" },
        repo: "team/api",
        title: `${type} on ${date}`,
        occurredAt: date + "T12:00:00Z",
      })),
    );
    const wall = { repositories: [], updatedAt: "2026-09-15T00:00:00Z" };
    const json = (data) =>
      new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json" },
      });
    window.activityRequests = [];
    window.fetch = async (input) => {
      const url = new URL(input, location.origin),
        params = url.searchParams;
      if (url.pathname === "/api/shared/events")
        return new Response(new ReadableStream({ start() {} }), {
          headers: { "content-type": "text/event-stream" },
        });
      if (url.pathname === "/api/shared/feed")
        return json({
          events,
          organization: "Test team",
          source: "workspace",
          updatedAt: wall.updatedAt,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          wall,
        });
      const selected = range(params.get("from"), params.get("to"));
      const selectedEvents = events.filter(
        (event) =>
          event.occurredAt >= selected.start && event.occurredAt < selected.end,
      );
      if (url.pathname === "/api/shared/pulse/dashboard")
        return json({
          range: selected,
          events: selectedEvents,
          wall,
          overview: {
            range: selected,
            totals,
            buckets: [],
            repositories: [],
            coverage,
            generatedAt: wall.updatedAt,
            comparison: {
              currentParticipants: 1,
              currentIncomplete: false,
              previous: {
                range: range("2026-08-31", "2026-09-06"),
                totals,
                participants: 1,
                coverage,
              },
            },
          },
        });
      if (url.pathname === "/api/shared/pulse/activity") {
        window.activityRequests.push(input);
        return json({
          events: selectedEvents.filter(
            (event) => !params.get("kind") || event.type === params.get("kind"),
          ),
          nextCursor: null,
        });
      }
      return json({});
    };
  });
  const overview = `http://shared.test/shared?period=custom&from=2026-09-07&to=2026-09-13#${"a".repeat(43)}`;
  for (const period of ["current", "previous"])
    for (const kind of ["merge", "review", "release"]) {
      await page.goto(overview);
      await page.addScriptTag({ content: bundle });
      await page
        .getByRole("button", {
          name: `View ${period} period ${kind}s: 1`,
          exact: true,
        })
        .click();
      const date = period === "current" ? "2026-09-10" : "2026-09-03";
      await page
        .getByRole("region", { name: "Historical activity" })
        .getByText(`${kind} on ${date}`, { exact: true })
        .waitFor();
      assert.equal(new URL(page.url()).searchParams.get("kind"), kind);
      assert.equal(await page.locator(".pulse-history .event-row").count(), 1);
      const request = new URL(
        await page.evaluate(() => window.activityRequests.at(-1)),
        page.url(),
      );
      assert.equal(request.searchParams.get("kind"), kind);
      assert.equal(
        request.searchParams.get("from"),
        period === "current" ? "2026-09-07" : "2026-08-31",
      );
      await page.reload();
      await page.addScriptTag({ content: bundle });
      await page
        .getByRole("region", { name: "Historical activity" })
        .getByText(`${kind} on ${date}`, { exact: true })
        .waitFor();
      assert.equal(await page.locator(".pulse-history .event-row").count(), 1);
    }
});
test("shared historical views stay silent on SSE updates and resume only for new live activity", async (t) => {
  const page = await browser.newPage({ reducedMotion: "no-preference" });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, []);
  });
  await page.route("**/*", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  const from = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const to = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  await page.goto(
    `http://shared.test/shared?period=custom&from=${from}&to=${to}&view=activity#${"a".repeat(43)}`,
  );
  await page.evaluate(() => {
    let controller;
    window.sharedEvents = [];
    const json = (data) =>
      new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json" },
      });
    window.fetch = async (url) => {
      if (url === "/api/shared/events")
        return new Response(
          new ReadableStream({
            start(value) {
              controller = value;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      if (url === "/api/shared/feed")
        return json({
          events: window.sharedEvents,
          organization: "Test team",
          source: "workspace",
          updatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          wall: { repositories: [], updatedAt: new Date().toISOString() },
        });
      if (url.startsWith("/api/shared/pulse/activity"))
        return json({ events: [], nextCursor: null });
      if (url.startsWith("/api/shared/pulse/dashboard")) {
        const params = new URL(url, location.origin).searchParams;
        const range = {
          from: params.get("from"),
          to: params.get("to"),
          start: params.get("from") + "T00:00:00.000Z",
          end: new Date(Date.parse(params.get("to")) + 86400000).toISOString(),
          granularity: "day",
        };
        return json({
          range,
          events: window.sharedEvents.filter(
            (event) =>
              event.occurredAt >= range.start && event.occurredAt < range.end,
          ),
          wall: { repositories: [], updatedAt: new Date().toISOString() },
          overview: {
            range,
            totals: { count: 0, merges: 0, reviews: 0, releases: 0 },
            buckets: [],
            repositories: [],
            coverage: { earliestStoredAt: null, retentionDays: null },
          },
        });
      }
      return json({});
    };
    window.addLiveEvent = (id) => {
      window.sharedEvents = [
        {
          id,
          type: "merge",
          actor: { login: "alice" },
          repo: "team/api",
          repositoryId: 1,
          title: id,
          occurredAt: new Date().toISOString(),
        },
        ...window.sharedEvents,
      ];
      controller.enqueue(
        new TextEncoder().encode("event: refresh\ndata: {}\n\n"),
      );
    };
  });
  await page.addScriptTag({ content: bundle });
  await page
    .getByRole("heading", { name: "Activity in selected period" })
    .waitFor();
  await page.evaluate(() => window.addLiveEvent("arrived-during-history"));
  await page.waitForFunction(() => window.sharedEvents.length === 1);
  assert.equal(
    await page
      .locator(".shared-event")
      .filter({ hasText: "arrived-during-history" })
      .count(),
    0,
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(await page.locator(".activity-celebration").count(), 0);
  assert.equal(await page.locator(".celebration-confetti").count(), 0);
  assert.equal(await page.locator(".activity-new").count(), 0);
  await page.getByRole("button", { name: "Back to Overview" }).click();
  await page.getByRole("button", { name: /^Period:/ }).waitFor();
  assert.equal(await page.locator(".activity-celebration").count(), 0);
  // Returning to Overview keeps the historical page scope and stays silent.
  await page.evaluate(() => window.addLiveEvent("still-historical"));
  await page.waitForFunction(() => window.sharedEvents.length === 2);
  assert.equal(await page.locator(".activity-celebration").count(), 0);
  await page.getByRole("button", { name: /^Period:/ }).click();
  await page.getByRole("option", { name: "Today", exact: true }).click();
  await page
    .getByRole("heading", { name: "Activity in this period", exact: true })
    .waitFor();
  await page.evaluate(() => window.addLiveEvent("arrived-after-return"));
  await page
    .locator(".activity-celebration")
    .filter({ hasText: "arrived-after-return" })
    .waitFor();
  assert.equal(
    await page
      .locator(".shared-event.activity-new")
      .filter({ hasText: "arrived-during-history" })
      .count(),
    0,
  );
});
