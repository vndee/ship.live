// Run with npm run test:browser. Mounts a probe's latency chart and the 90-day
// uptime strip with fixed data, and checks the check rail and hover details.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright"
);
let browser;
let script;
let styles;

before(async () => {
  const built = await build({
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import "./src/styles.css";
        import "./src/components/service-health.css";
        import { LatencyChart } from "./src/components/LatencyChart.tsx";
        import { UptimeStrip } from "./src/components/UptimeStrip.tsx";
        const now = Date.parse("2026-09-10T12:00:00Z");
        // Newest first, like a snapshot; the third newest check failed.
        const history = Array.from({ length: 10 }, (_, index) => ({
          checkedAt: new Date(now - index * 60000).toISOString(),
          ok: index !== 2,
          latencyMs: index === 2 ? 900 : 100 + index,
          statusCode: index === 2 ? 503 : 200,
          reason: index === 2 ? "Service unavailable." : "Probe passed.",
          status: index === 2 ? "degraded" : "healthy",
        }));
        const days = Array.from({ length: 90 }, (_, index) => ({
          date: new Date(Date.UTC(2026, 5, 13) + index * 86400000)
            .toISOString()
            .slice(0, 10),
          checks: 1440,
          passed: index === 89 ? 1439 : 1440,
          uptime: index === 89 ? 1439 / 1440 : 1,
        }));
        createRoot(document.getElementById("root")).render(
          React.createElement(
            "main",
            { style: { width: "800px", padding: "120px 20px 20px" } },
            React.createElement(LatencyChart, { name: "Health", history, now }),
            React.createElement(UptimeStrip, { days }),
          ),
        );
      `,
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    outdir: "out",
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    loader: {
      ".woff": "empty",
      ".woff2": "empty",
      ".svg": "dataurl",
      ".png": "empty",
    },
    define: { "process.env.NODE_ENV": '"development"' },
  });
  script = built.outputFiles.find((file) => file.path.endsWith(".js")).text;
  styles =
    built.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "";
  browser = await chromium.launch({ headless: true });
});
after(async () => browser?.close());

async function open(t) {
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    await context.close();
    assert.deepEqual(errors, []);
  });
  await page.route("**/*", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("http://ship.test/");
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  await page.waitForSelector(".latency-rail");
  return page;
}

test("recent checks show each result on a rail under their points", async (t) => {
  const page = await open(t);
  const rails = page.locator(".latency-rail");
  assert.equal(await rails.count(), 10);
  assert.equal(await page.locator(".latency-rail.is-failed").count(), 1);
  assert.equal(await page.locator(".latency-point.is-failed").count(), 1);
  // Oldest first: the third newest check is the eighth segment.
  assert.equal(
    await rails.nth(7).evaluate((rail) => rail.classList.contains("is-failed")),
    true,
  );
  const segments = await rails.evaluateAll((items) =>
    items.map((rail) => {
      const box = rail.getBoundingClientRect();
      return { left: box.left, right: box.right };
    }),
  );
  const centers = await page.locator(".latency-point").evaluateAll((items) =>
    items.map((point) => {
      const box = point.getBoundingClientRect();
      return box.left + box.width / 2;
    }),
  );
  centers.forEach((center, index) =>
    assert.ok(
      center > segments[index].left && center < segments[index].right,
      `point ${index} sits over its segment`,
    ),
  );
});

test("hovering a check shows its result and failure reason", async (t) => {
  const page = await open(t);
  await page.locator(".latency-rail.is-failed").hover();
  const tip = page.locator(".latency-tooltip");
  await tip.waitFor();
  assert.match(
    await tip.innerText(),
    /900 ms\s+Failed · HTTP 503\s+Service unavailable\./,
  );
  assert.equal(await page.locator(".latency-rail.is-active").count(), 1);
});

test("hovering a day in the 90-day strip shows its uptime, and leaving hides it", async (t) => {
  const page = await open(t);
  const tip = page.locator(".block-tooltip");
  await page.locator(".uptime-bar").last().hover();
  await tip.waitFor();
  assert.match(
    await tip.innerText(),
    /Thu, Sep 10, 2026\s+99\.9305% uptime\s+1,439 of 1,440 checks passed/,
  );
  const box = await tip.boundingBox();
  assert.ok(box.x >= 8 && box.x + box.width <= page.viewportSize().width - 8);
  await page.mouse.move(5, 5);
  await tip.waitFor({ state: "detached" });
});
