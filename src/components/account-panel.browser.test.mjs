// Run with npm run test:browser. Mounts the account panel with a fake controller.
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
        import { AccountPanel } from "./src/components/AccountPanel.tsx";
        const workspaces = [
          { id: "p", name: "Huynh Duy's journal", kind: "personal", owner: true },
          { id: "t", name: "Platform crew", defaultName: "kamilabs-ai", githubAccount: "kamilabs-ai", kind: "team", owner: false, installationId: 70 },
          { id: "b", name: "BMS-Harmony", githubAccount: "BMS-Harmony", kind: "team", owner: false, installationId: 71 },
        ];
        window.renamed = [];
        const feed = new Proxy({
          session: { user: { id: "u", name: "Huynh Duy" } },
          sessionLoading: false,
          demo: false,
          operation: undefined,
          githubConnected: false,
          githubAppConfigured: true,
          workspaces,
          workspace: workspaces[0],
          selectWorkspace: () => {},
          renameWorkspace: async (id, name) => {
            if (name === "fail") throw new Error("Keep the name to 80 characters.");
            window.renamed.push([id, name]);
          },
        }, { get: (target, key) => (key in target ? target[key] : () => undefined) });
        createRoot(document.getElementById("root")).render(
          React.createElement(AccountPanel, { feed, onClose: () => {} }),
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

async function open(t) {
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
  await page.goto("http://ship.test/");
  await page.addScriptTag({ content: script });
  await page.waitForSelector(".workspace-row");
  return page;
}

test("a renamed team keeps its GitHub name beside it", async (t) => {
  const page = await open(t);
  const rows = page.locator(".workspace-row");
  assert.match(await rows.nth(1).textContent(), /Platform crew/);
  assert.match(await rows.nth(1).textContent(), /kamilabs-ai · Team/);
  // An unrenamed team shows its name once.
  assert.doesNotMatch(await rows.nth(2).textContent(), /BMS-Harmony ·/);
});

test("renaming saves the trimmed name, and a failure shows why", async (t) => {
  const page = await open(t);
  await page.getByRole("button", { name: "Rename BMS-Harmony" }).click();
  const input = page.getByLabel("Workspace name");
  assert.equal(await input.inputValue(), "");
  assert.equal(await input.getAttribute("placeholder"), "BMS-Harmony");
  await input.fill("  Harmony  ");
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForFunction(() => window.renamed.length === 1);
  assert.deepEqual(await page.evaluate(() => window.renamed), [
    ["b", "Harmony"],
  ]);
  await page.getByRole("button", { name: "Rename Platform crew" }).click();
  assert.equal(
    await page.getByLabel("Workspace name").inputValue(),
    "Platform crew",
  );
  await page.getByLabel("Workspace name").fill("fail");
  await page.getByRole("button", { name: "Save" }).click();
  assert.match(
    await page
      .locator(".workspace-rename-form")
      .getByRole("alert")
      .textContent(),
    /Keep the name to 80 characters/,
  );
});
