// Run with npm run test:browser. Mounts the service health share dialog
// against a fake API.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright"
);
let browser;
let script;

before(async () => {
  const built = await build({
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { HealthSharePanel } from "./src/components/HealthSharePanel.tsx";
        createRoot(document.getElementById("root")).render(
          React.createElement(HealthSharePanel, {
            workspaceId: "team-a",
            csrfToken: "csrf",
          }),
        );
      `,
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
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
  script = built.outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
});
after(async () => browser?.close());

const TOKEN = "t".repeat(43);
const share = (extra = {}) => ({
  id: "s1",
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  repositoryCount: 3,
  ...extra,
});

async function open(t, current) {
  const context = await browser.newContext();
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
  await page.goto("http://ship.test/health");
  await page.evaluate((current) => {
    // Records each request; a POST answers with a new link.
    window.requests = [];
    window.fetch = async (url, init = {}) => {
      const method = init.method ?? "GET";
      window.requests.push({
        url: String(url),
        method,
        body: init.body ? JSON.parse(init.body) : null,
      });
      const body =
        method === "POST"
          ? {
              ...current,
              id: `s${window.requests.length}`,
              token: "n".repeat(43),
            }
          : { share: current };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
  }, current);
  await page.addScriptTag({ content: script });
  return page;
}

test("the creator sees the active link again, ready to copy", async (t) => {
  const page = await open(t, share({ token: TOKEN }));
  const link = page.getByRole("textbox", {
    name: "Service health share link",
  });
  await link.waitFor();
  assert.equal(
    await link.inputValue(),
    `http://ship.test/share/health#${TOKEN}`,
  );
  assert.ok(await page.getByRole("button", { name: "Copy link" }).isVisible());
  assert.equal(await page.getByText(/Rotate it once/).count(), 0);
});

test("a link from before tokens were kept asks for one rotation", async (t) => {
  const page = await open(t, share());
  await page.getByText(/Rotate it once to get a link you can copy/).waitFor();
  assert.equal(
    await page
      .getByRole("textbox", { name: "Service health share link" })
      .count(),
    0,
  );
});

test("rotating keeps the current expiry unless another lifetime is chosen", async (t) => {
  const page = await open(t, share({ token: TOKEN }));
  const keep = page.getByRole("checkbox", { name: /Keep the current expiry/ });
  assert.equal(await keep.isChecked(), true);
  const lifetime = page.getByRole("button", {
    name: /^Health link expiration/,
  });
  assert.equal(await lifetime.isDisabled(), true);
  const posts = () =>
    page.evaluate(() =>
      window.requests.filter((item) => item.method === "POST"),
    );
  await page.getByRole("button", { name: "Rotate link" }).click();
  await page.waitForFunction(() =>
    window.requests.some((item) => item.method === "POST"),
  );
  const [kept] = await posts();
  assert.match(kept.url, /\/health\/share\/rotate$/);
  assert.deepEqual(kept.body, { keepExpiry: true });
  await keep.uncheck();
  assert.equal(await lifetime.isDisabled(), false);
  await page.getByRole("button", { name: "Rotate link" }).click();
  await page.waitForFunction(
    () => window.requests.filter((item) => item.method === "POST").length === 2,
  );
  assert.deepEqual((await posts())[1].body, { expiresIn: 86400 });
});
