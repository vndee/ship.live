// Run with npm run test:browser. Mounts the dashboard sources form with a fake save.
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
        import { PersonalSourcesForm } from "./src/components/PersonalSourcesForm.tsx";
        window.saved = [];
        createRoot(document.getElementById("root")).render(
          React.createElement(PersonalSourcesForm, {
            sources: { installationIds: null, mineOnly: true },
            options: [
              { id: 70, name: "acme", kind: "team" },
              { id: 71, name: "builder-a", kind: "personal" },
            ],
            onCancel: () => window.saved.push("cancel"),
            onSave: async (sources) => {
              if (window.fail) throw new Error("Choose installations you have connected.");
              window.saved.push(sources);
            },
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
  return page;
}
const saved = (page) => page.evaluate(() => window.saved);

test("every connected installation is the default, and a chosen subset saves", async (t) => {
  const page = await open(t);
  // Following every installation hides the individual choices.
  assert.equal(await page.getByRole("checkbox", { name: "acme" }).count(), 0);
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForFunction(() => window.saved.length === 1);
  assert.deepEqual((await saved(page))[0], {
    installationIds: null,
    mineOnly: true,
  });
  await page.getByLabel("Only the ones I choose").check();
  await page.getByRole("checkbox", { name: "builder-a" }).uncheck();
  await page.getByLabel("Only my activity").uncheck();
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForFunction(() => window.saved.length === 2);
  assert.deepEqual((await saved(page))[1], {
    installationIds: [70],
    mineOnly: false,
  });
});

test("a failed save shows its reason", async (t) => {
  const page = await open(t);
  await page.evaluate(() => {
    window.fail = true;
  });
  await page.getByRole("button", { name: "Save" }).click();
  assert.match(
    await page.getByRole("alert").textContent(),
    /Choose installations you have connected/,
  );
});
