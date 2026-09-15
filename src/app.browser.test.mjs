// Run with npm run test:browser. Exercises URL routing in the signed-out demo;
// every API response is fake and the page never leaves its test origin.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright"
);
let browser;
let bundle;

before(async () => {
  const built = await build({
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import App from "./src/App.tsx";
        createRoot(document.getElementById("root")).render(React.createElement(App));
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
  bundle = built.outputFiles[0].text;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  });
});
after(async () => browser?.close());

async function open(t, path) {
  // Reduced motion keeps Pulse on the scene the test chooses.
  const context = await browser.newContext({ reducedMotion: "reduce" });
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
  await page.goto(`http://ship.test${path}`);
  await page.evaluate(() => {
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      });
    window.fetch = async (path) =>
      path === "/api/session"
        ? json({
            user: null,
            providers: { google: false, github: false },
            configured: false,
          })
        : json({ error: "Not found." }, 404);
  });
  await page.addScriptTag({ content: bundle });
  await page.waitForSelector("h1");
  return page;
}
const location = (page) => {
  const url = new URL(page.url());
  return url.pathname + url.search;
};
const heading = (page, text) =>
  page.waitForFunction(
    (text) => document.querySelector("h1")?.textContent === text,
    text,
  );
const historyLength = (page) => page.evaluate(() => history.length);

test("each page has a URL, a title, and a place in history", async (t) => {
  const page = await open(t, "/");
  await heading(page, "Great work. Shared momentum.");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Service Health" })
    .click();
  await heading(page, "Service Health");
  assert.equal(location(page), "/health");
  assert.equal(await page.title(), "Service Health · ship.live");
  assert.equal(
    await page
      .getByRole("link", { name: "Service Health" })
      .getAttribute("aria-current"),
    "page",
  );
  await page.goBack();
  await heading(page, "Great work. Shared momentum.");
  assert.equal(location(page), "/");
  assert.equal(await page.title(), "ship.live — Great work. Shared momentum.");
});

test("a Live feed link restores its filters, and filter changes replace history", async (t) => {
  const page = await open(t, "/feed?type=merge&q=a&period=7d");
  await heading(page, "The activity log.");
  assert.equal(await page.inputValue('input[type="search"]'), "a");
  assert.equal(
    await page.inputValue('select[aria-label="Activity type"]'),
    "merge",
  );
  assert.equal(
    await page.inputValue('select[aria-label="Activity time period"]'),
    "7d",
  );
  const entries = await historyLength(page);
  await page.fill('input[type="search"]', "ship it");
  await page.selectOption('select[aria-label="Activity type"]', "review");
  assert.equal(location(page), "/feed?type=review&q=ship+it&period=7d");
  assert.equal(await historyLength(page), entries);
  await page.getByRole("button", { name: "Reset" }).click();
  assert.equal(location(page), "/feed?period=7d");
  await page.getByRole("link", { name: "Pulse" }).first().click();
  await heading(page, "Great work. Shared momentum.");
  assert.equal(location(page), "/");
});

test("a profile opens over the page, and Back closes it", async (t) => {
  const page = await open(t, "/");
  await page.getByRole("button", { name: "Leaderboard" }).click();
  await page
    .getByRole("button", { name: /^Open .+'s profile$/ })
    .first()
    .click();
  await page.waitForSelector("dialog.modal[open]");
  assert.match(location(page), /^\/\?person=[a-z]+$/);
  await page.goBack();
  await page.waitForFunction(() => !document.querySelector("dialog.modal"));
  assert.equal(location(page), "/");
});

test("a shared profile link opens directly and closes without a history entry", async (t) => {
  const page = await open(t, "/team?person=sarahpark");
  await heading(page, "The people behind it.");
  await page.waitForSelector("dialog.modal[open]");
  assert.equal(
    await page.locator("dialog.modal h2").first().textContent(),
    "Sarah Park",
  );
  const entries = await historyLength(page);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("dialog.modal"));
  assert.equal(location(page), "/team");
  assert.equal(await historyLength(page), entries);
});

test("unknown paths and malformed parameters show Pulse", async (t) => {
  const page = await open(t, "/nowhere?person=<script>");
  await heading(page, "Great work. Shared momentum.");
  assert.equal(await page.locator("dialog.modal").count(), 0);
});

test("a repository in Overview opens its feed with the same calendar range", async (t) => {
  const page = await open(t, "/");
  const button = page
    .getByRole("button", { name: /^View activity for / })
    .first();
  const repo = (await button.getAttribute("aria-label")).replace(
    "View activity for ",
    "",
  );
  await button.click();
  const url = new URL(page.url());
  assert.equal(url.pathname, "/feed");
  assert.equal(url.searchParams.get("repo"), repo);
  assert.match(url.searchParams.get("from"), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(url.searchParams.get("to"), /^\d{4}-\d{2}-\d{2}$/);
  await page
    .getByRole("heading", { name: "Activity in selected period" })
    .waitFor();
});

test("Overview calendar presets persist, custom dates apply explicitly, and drill-down keeps dates", async (t) => {
  const page = await open(t, "/");
  await page.getByRole("button", { name: /^Period:/ }).click();
  await page.getByRole("option", { name: "Last 30 days" }).click();
  assert.equal(location(page), "/?period=30d");
  await page
    .getByRole("heading", { name: "Activity in this period", exact: true })
    .waitFor();
  await page.getByRole("button", { name: /^Period:/ }).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.getByLabel("From date").fill("2026-09-01");
  await page.getByLabel("To date").fill("2026-09-10");
  assert.equal(location(page), "/?period=30d");
  await page.getByRole("button", { name: "Apply dates" }).click();
  assert.equal(location(page), "/?period=custom&from=2026-09-01&to=2026-09-10");
  await page
    .getByRole("button", { name: "View activity in this period" })
    .click();
  assert.equal(location(page), "/feed?from=2026-09-01&to=2026-09-10");
  await page
    .getByRole("heading", { name: "Activity in selected period" })
    .waitFor();
  await page.goBack();
  await page.getByRole("button", { name: "Period: Custom dates" }).waitFor();
  await page.goBack();
  await page.getByRole("button", { name: "Period: Last 30 days" }).waitFor();
});

test("Overview explains invalid custom links without silently showing default totals", async (t) => {
  const page = await open(t, "/?period=custom&from=2026-02-30&to=2026-03-01");
  await page.locator("[data-pulse-error]").waitFor();
  assert.equal(await page.locator("[data-pulse-total]").count(), 0);
});
