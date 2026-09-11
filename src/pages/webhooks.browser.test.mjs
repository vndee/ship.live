// Run with npm run test:browser. Mounts the Webhooks page against a fake API.
// Set SCREENSHOT_DIR to save screenshots of the page and editor.
import assert from "node:assert/strict";
import { join } from "node:path";
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
        import { WebhooksPage } from "./src/pages/WebhooksPage.tsx";
        createRoot(document.getElementById("root")).render(
          React.createElement("main", {},
            React.createElement(WebhooksPage, {
              workspace: { id: "team-a", name: "Acme" },
              csrfToken: "csrf",
            })),
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

const delivered = {
  id: "d1",
  eventId: "e1",
  eventType: "incident.opened",
  summary: "Incident: Public API / Health is down",
  status: "succeeded",
  attempts: 1,
  requestBody: '{"text":"Incident: Public API / Health is down"}',
  responseStatus: 200,
  responseBody: "ok",
  error: null,
  createdAt: new Date(Date.now() - 120_000).toISOString(),
  finishedAt: new Date(Date.now() - 119_000).toISOString(),
  nextAttemptAt: null,
};

async function open(t, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    await context.close();
    assert.deepEqual(errors, []);
  });
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html data-theme="dark"><head><style>${styles}</style></head><body><div id="root"></div></body></html>`,
    }),
  );
  await page.goto("http://ship.test/webhooks");
  await page.evaluate((delivered) => {
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      });
    const webhook = {
      id: "w1",
      name: "Incidents to #ops",
      preset: "slack",
      urlHint: "https://hooks.slack.com/services/…",
      method: "POST",
      contentType: "application/json",
      template: "{}",
      headerNames: [],
      hasSecret: false,
      signing: "ship",
      successPath: "",
      successValue: null,
      events: ["incident.opened", "incident.resolved"],
      filters: {},
      cooldownSeconds: 600,
      enabled: true,
      pausedReason: null,
      creator: { id: "u1", name: "Sarah Park" },
      createdAt: "2026-09-10T08:00:00.000Z",
      updatedAt: "2026-09-10T08:00:00.000Z",
      lastDelivery: delivered,
    };
    window.requests = [];
    window.fetch = async (path, init = {}) => {
      window.requests.push({
        path,
        method: init.method ?? "GET",
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      if (path === "/api/workspaces/team-a/webhooks" && !init.method)
        return json({
          configured: true,
          webhooks: [webhook],
          inbound: [
            {
              id: "i1",
              name: "Grafana alerts",
              slug: "grafana",
              mapping: {
                title: "{{payload.title}}",
                body: "",
                url: "",
                id: "",
              },
              hasSecret: true,
              creator: { id: "u1", name: "Sarah Park" },
              createdAt: "2026-09-10T08:00:00.000Z",
              lastReceivedAt: "2026-09-10T08:00:00.000Z",
              receipts: [],
            },
          ],
        });
      if (path === "/api/workspaces/team-a/webhooks" && init.method === "POST")
        return json({ webhook: { ...webhook, id: "w2", name: "New" } }, 201);
      if (path.endsWith("/deliveries"))
        return json({ deliveries: [delivered] });
      if (path.endsWith("/test"))
        return json({
          ok: true,
          status: 200,
          body: "ok",
          latencyMs: 84,
          requestBody: "{}",
        });
      return json({ error: "Not found." }, 404);
    };
  }, delivered);
  await page.addScriptTag({ content: script });
  await page.waitForSelector(".webhook-row");
  return page;
}

async function shot(page, name, locator) {
  if (!process.env.SCREENSHOT_DIR) return;
  const path = join(process.env.SCREENSHOT_DIR, `${name}.png`);
  if (locator) await locator.screenshot({ path });
  else await page.screenshot({ path, fullPage: true });
}

test("the page lists webhooks with their latest delivery and inbound endpoints", async (t) => {
  const page = await open(t);
  const row = page.locator(".webhook-row").first();
  assert.match(await row.textContent(), /Incidents to #ops/);
  assert.match(
    await row.textContent(),
    /Slack · POST https:\/\/hooks\.slack\.com\/services\/…/,
  );
  assert.match(await row.textContent(), /10 min cooldown/);
  assert.equal(
    await row.locator(".webhook-status-chip").textContent(),
    "Delivered",
  );
  assert.match(
    await page.locator(".webhook-row").nth(1).textContent(),
    /inbound\.grafana · signed/,
  );
  await shot(page, "webhooks-page");
});

test("the editor previews presets live, signs Lark bodies, and blocks invalid templates", async (t) => {
  const page = await open(t);
  await page.getByRole("button", { name: "New webhook" }).click();
  await page.waitForSelector("dialog.modal[open]");
  // Wide enough for the template and its preview side by side.
  const dialog = await page.locator("dialog.modal[open]").boundingBox();
  assert.ok(dialog.width > 900, `the editor is ${dialog.width}px wide`);
  await shot(page, "webhook-editor", page.locator("dialog.modal[open]"));
  // Scroll the dialog to the template and its preview, side by side.
  await page
    .getByLabel("Rendered body")
    .evaluate((node) => node.scrollIntoView({ block: "center" }));
  await shot(
    page,
    "webhook-editor-template",
    page.locator("dialog.modal[open]"),
  );
  const preview = page.getByLabel("Rendered body");
  assert.match(await preview.textContent(), /"blocks"/);
  await page.getByLabel("Preset").selectOption("lark");
  assert.match(await preview.textContent(), /"msg_type": "interactive"/);
  assert.doesNotMatch(await preview.textContent(), /"sign"/);
  await page.getByText("Request, signing, and headers").click();
  await page.getByRole("combobox", { name: /^Secret/ }).selectOption("custom");
  await page.getByLabel("Lark bot secret").fill("lark-bot-secret");
  assert.match(await preview.textContent(), /"sign": "\(computed when sent\)"/);
  assert.equal(
    await page.getByLabel("Success check (JSON path)").inputValue(),
    "code",
  );
  await shot(page, "webhook-editor-lark", page.locator("dialog.modal"));

  await page.getByLabel("Body template").fill('{"text": {{summary}}}');
  assert.match(
    await page.locator(".webhook-preview .form-error").textContent(),
    /not valid JSON/,
  );
  assert.equal(
    await page.getByRole("button", { name: "Create webhook" }).isDisabled(),
    true,
  );
  assert.equal(await page.getByLabel("Preset").inputValue(), "custom");

  await page.getByLabel("Preset").selectOption("slack");
  await page.getByLabel("Name", { exact: true }).fill("CI to #eng");
  await page
    .getByLabel("URL", { exact: true })
    .fill("https://hooks.slack.com/services/T/B/x");
  await page.getByRole("checkbox", { name: "CI started failing" }).check();
  await page.getByRole("button", { name: "Create webhook" }).click();
  await page.waitForFunction(() => !document.querySelector("dialog.modal"));
  const saved = await page.evaluate(() =>
    window.requests.find((request) => request.method === "POST"),
  );
  assert.equal(saved.body.preset, "slack");
  assert.equal(saved.body.name, "CI to #eng");
  assert.equal(saved.body.url, "https://hooks.slack.com/services/T/B/x");
  assert.deepEqual(saved.body.events.sort(), [
    "incident.opened",
    "incident.resolved",
    "pipeline.failed",
  ]);
  assert.equal(saved.body.secret, undefined);
  assert.equal(saved.body.successPath, "");
});

test("the delivery log shows attempts and sends a test", async (t) => {
  const page = await open(t);
  await page.getByRole("button", { name: "Deliveries" }).click();
  await page.waitForSelector(".delivery-row");
  assert.match(await page.locator(".delivery-row").textContent(), /Delivered/);
  await page.locator(".delivery-summary").click();
  assert.match(
    await page.locator(".delivery-details").textContent(),
    /Request body/,
  );
  await page.getByRole("button", { name: "Send test" }).click();
  await page.waitForSelector(".delivery-result.ok");
  assert.match(
    await page.locator(".delivery-result").textContent(),
    /Delivered · HTTP 200 in 84 ms/,
  );
  const test = await page.evaluate(() =>
    window.requests.find((request) => request.path.endsWith("/test")),
  );
  assert.deepEqual(test.body, { eventType: "incident.opened" });
  await shot(page, "webhook-deliveries", page.locator("dialog.modal"));
});

test("the page fits a phone screen", async (t) => {
  const page = await open(t, { width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    ),
    false,
  );
  await shot(page, "webhooks-mobile");
});
