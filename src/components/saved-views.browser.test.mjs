import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright"
);
let browser, script;
const workspace = "711d7aec-270d-40a7-b52c-70ea31b952ca";
before(async () => {
  const output = await build({
    stdin: {
      contents: `import React from 'react';import{createRoot}from'react-dom/client';import{SavedViews}from'./src/components/SavedViews';const root=createRoot(document.getElementById('root'));window.opened=[];window.renderView=(scopeKey='one',href='/?workspace=${workspace}&scene=review')=>root.render(<SavedViews key={scopeKey} csrfToken={'ab'.repeat(32)} scopeKey={scopeKey} currentHref={href} onOpen={href=>window.opened.push(href)}/>);window.renderView();`,
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    loader: { ".css": "empty" },
  });
  script = output.outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
});
after(async () => browser?.close());
async function open(t) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const rows = [];
  let fail = false;
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route("**/*", async (route) => {
    const req = route.request();
    if (!req.url().includes("/api/saved-views"))
      return route.fulfill({
        contentType: "text/html",
        body: '<div id="root"></div>',
      });
    if (fail)
      return route.fulfill({
        status: 503,
        json: { error: "Saved views temporarily unavailable." },
      });
    const id = new URL(req.url()).pathname.split("/")[3];
    if (req.method() === "POST") {
      const body = req.postDataJSON();
      rows.push({
        ...body,
        id: "view-" + rows.length,
        workspaceId: workspace,
        createdAt: "2026-09-15T00:00:00Z",
        updatedAt: "2026-09-15T00:00:00Z",
      });
      return route.fulfill({ status: 201, json: rows.at(-1) });
    }
    if (req.method() === "PATCH") {
      const row = rows.find((r) => r.id === id);
      Object.assign(row, req.postDataJSON());
      return route.fulfill({ json: row });
    }
    if (req.method() === "DELETE") {
      rows.splice(
        rows.findIndex((r) => r.id === id),
        1,
      );
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: { views: rows } });
  });
  await page.goto("http://ship.test");
  await page.addScriptTag({ content: script });
  return {
    page,
    rows,
    setFail: (v) => {
      fail = v;
    },
  };
}
test("saved views persist rolling filters and reopen a named view", async (t) => {
  const { page, rows } = await open(t);
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  await page.getByLabel("View name", { exact: true }).fill("Review morning");
  await page
    .getByRole("button", { name: "Save current view", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Review morning", exact: true })
    .waitFor();
  assert.equal(rows[0].href, `/?workspace=${workspace}&scene=review&period=7d`);
  assert.ok(
    await page.getByText("Rolling last 7 days", { exact: true }).count(),
  );
  await page.getByRole("link", { name: "Review morning", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.opened), [
    `/?workspace=${workspace}&scene=review&period=7d`,
  ]);
  assert.equal(await page.getByRole("dialog").count(), 0);
});
test("saved views can be renamed, updated to fixed dates and deleted", async (t) => {
  const { page, rows } = await open(t);
  rows.push({
    id: "existing",
    name: "Old",
    href: `/?workspace=${workspace}&scene=review&period=7d`,
  });
  await page.evaluate(
    (w) =>
      window.renderView(
        "one",
        `/?workspace=${w}&period=custom&from=2026-09-01&to=2026-09-07`,
      ),
    workspace,
  );
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  await page.getByRole("button", { name: "Rename Old", exact: true }).click();
  await page.getByLabel("New view name").fill("Launch");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await page.getByRole("link", { name: "Launch", exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Update Launch to current view", exact: true })
    .click();
  await page
    .getByText("2026-09-01 – 2026-09-07 · fixed UTC dates", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Delete Launch", exact: true })
    .click();
  await page.getByText("No saved views yet.", { exact: true }).waitFor();
  assert.equal(rows.length, 0);
});
test("failed saved-view reads hide the list and allow retry", async (t) => {
  const { page, setFail } = await open(t);
  setFail(true);
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  await page
    .getByText("Saved views temporarily unavailable.", { exact: true })
    .waitFor();
  assert.equal(await page.getByRole("link").count(), 0);
  setFail(false);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByText("No saved views yet.", { exact: true }).waitFor();
});

test("an older initial list response cannot erase a newly saved view", async (t) => {
  const { page } = await open(t);
  let releaseInitial;
  const initialGate = new Promise((resolve) => {
    releaseInitial = resolve;
  });
  let initialRequested;
  const requested = new Promise((resolve) => {
    initialRequested = resolve;
  });
  let reads = 0;
  await page.route("**/api/saved-views", async (route) => {
    if (route.request().method() !== "GET" || ++reads !== 1)
      return route.fallback();
    initialRequested();
    await initialGate;
    await route.fulfill({ json: { views: [] } });
  });
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  await requested;
  await page.getByLabel("View name", { exact: true }).fill("New review view");
  await page
    .getByRole("button", { name: "Save current view", exact: true })
    .click();
  await page
    .getByRole("link", { name: "New review view", exact: true })
    .waitFor();
  const oldResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().endsWith("/api/saved-views"),
  );
  releaseInitial();
  await oldResponse;
  await page.waitForTimeout(50);
  assert.equal(
    await page
      .getByRole("link", { name: "New review view", exact: true })
      .count(),
    1,
    "The latest successful save must remain visible after an older list read finishes",
  );
});
