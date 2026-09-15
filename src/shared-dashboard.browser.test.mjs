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
      if (url.startsWith("/api/shared/pulse/overview")) {
        const params = new URL(url, location.origin).searchParams;
        return json({
          range: {
            from: params.get("from"),
            to: params.get("to"),
            granularity: "day",
          },
          totals: { count: 0, merges: 0, reviews: 0, releases: 0 },
          buckets: [],
          repositories: [],
          coverage: { earliestStoredAt: null, retentionDays: null },
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
  await page
    .locator(".shared-event")
    .filter({ hasText: "arrived-during-history" })
    .waitFor();
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
