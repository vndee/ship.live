// Run with npm run test:browser. Mounts the Pulse heading form with a fake save.
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
        import { PulseHeadingForm } from "./src/components/PulseHeadingForm.tsx";
        window.saved = [];
        createRoot(document.getElementById("root")).render(
          React.createElement(PulseHeadingForm, {
            title: "Old title",
            subtitle: "",
            defaultTitle: "Great work. Shared momentum.",
            team: true,
            onCancel: () => window.saved.push("cancel"),
            onSave: async (title, subtitle) => {
              if (title === "fail") throw new Error("Keep the title to 80 characters.");
              window.saved.push([title, subtitle]);
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

test("the form saves trimmed values and resets to the default", async (t) => {
  const page = await open(t);
  await page.getByLabel("Title", { exact: true }).fill("  Ship it, together  ");
  await page.getByLabel("Subtitle", { exact: true }).fill(" Platform team ");
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForFunction(() => window.saved.length === 1);
  assert.deepEqual(await saved(page), [["Ship it, together", "Platform team"]]);
  await page.getByRole("button", { name: "Reset to default" }).click();
  await page.waitForFunction(() => window.saved.length === 2);
  assert.deepEqual((await saved(page))[1], ["", ""]);
});

test("a failed save shows its error and keeps the form open", async (t) => {
  const page = await open(t);
  await page.getByLabel("Title", { exact: true }).fill("fail");
  await page.getByRole("button", { name: "Save" }).click();
  assert.equal(
    await page.getByRole("alert").textContent(),
    "Keep the title to 80 characters.",
  );
  assert.equal(
    await page.getByRole("button", { name: "Save" }).isEnabled(),
    true,
  );
  assert.equal(
    await page.getByPlaceholder("Great work. Shared momentum.").count(),
    1,
  );
});
