// Run with npm run test:browser. Mounts the status strips with fixed data and
// checks their width and hover details.
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
        import { ProbeCheckStrip } from "./src/components/ProbeCheckStrip.tsx";
        import { UptimeStrip } from "./src/components/UptimeStrip.tsx";
        const now = Date.parse("2026-09-10T12:00:00Z");
        // Newest first, like a snapshot; the third newest check failed.
        const history = Array.from({ length: 10 }, (_, index) => ({
          checkedAt: new Date(now - index * 60000).toISOString(),
          ok: index !== 2,
          latencyMs: 100 + index,
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
            React.createElement(ProbeCheckStrip, { name: "Health", history }),
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
  await page.waitForSelector(".health-history");
  return page;
}

test("a probe's strip spans its width with 40 slots, newest on the right", async (t) => {
  const page = await open(t);
  const slots = page.locator(".health-history > span");
  assert.equal(await slots.count(), 40);
  assert.equal(
    await page.locator(".health-history > .health-none").count(),
    30,
  );
  const strip = await page.locator(".health-history").boundingBox();
  const first = await slots.first().boundingBox();
  const last = await slots.last().boundingBox();
  assert.ok(Math.abs(first.x - strip.x) < 1);
  assert.ok(Math.abs(last.x + last.width - (strip.x + strip.width)) < 1);
});

test("hovering a block shows its details, and leaving hides them", async (t) => {
  const page = await open(t);
  const tip = page.locator(".block-tooltip");
  await page.locator(".health-history > span").last().hover();
  await tip.waitFor();
  assert.match(await tip.innerText(), /Passed · HTTP 200 · 100 ms/);
  await page.locator(".health-history > span").nth(37).hover();
  assert.match(
    await tip.innerText(),
    /Failed · HTTP 503 · 102 ms\s+Service unavailable\./,
  );
  await page.locator(".health-history > span").first().hover();
  assert.match(await tip.innerText(), /No check yet/);
  await page.locator(".uptime-bar").last().hover();
  assert.match(
    await tip.innerText(),
    /Thu, Sep 10, 2026\s+99\.9305% uptime\s+1,439 of 1,440 checks passed/,
  );
  // The tooltip stays inside the window.
  const box = await tip.boundingBox();
  assert.ok(box.x >= 8 && box.x + box.width <= page.viewportSize().width - 8);
  await page.mouse.move(5, 5);
  await tip.waitFor({ state: "detached" });
});
