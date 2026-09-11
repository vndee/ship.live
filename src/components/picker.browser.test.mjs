// Run with npm run test:browser. Mounts the app's dropdown with fixed options.
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
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { Picker } from "./src/components/Picker.tsx";
        const options = ["production", "preview", "staging"].map((value) => ({ value, label: value }));
        function Demo() {
          const [value, setValue] = useState("production");
          return React.createElement("main", {},
            React.createElement(Picker, { label: "Environment", value, options, onChange: setValue }),
            React.createElement("output", {}, value));
        }
        createRoot(document.getElementById("root")).render(React.createElement(Demo));
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

test("the dropdown opens a listbox and picks by mouse", async (t) => {
  const page = await open(t);
  const trigger = page.getByRole("button", { name: "Environment: production" });
  await trigger.click();
  const listbox = page.getByRole("listbox", { name: "Environment" });
  await listbox.waitFor();
  assert.equal(
    await page.getByRole("option", { selected: true }).textContent(),
    "production",
  );
  await page.getByRole("option", { name: "staging" }).click();
  assert.equal(await listbox.count(), 0);
  assert.equal(await page.locator("output").textContent(), "staging");
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    ),
    "Environment: staging",
  );
});

test("the keyboard moves through options, and Escape or a click outside closes", async (t) => {
  const page = await open(t);
  await page.getByRole("button", { name: /^Environment:/ }).focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("listbox").waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("output").textContent(), "preview");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("listbox").count(), 0);
  await page.getByRole("button", { name: /^Environment:/ }).click();
  await page.mouse.click(5, 300);
  assert.equal(await page.getByRole("listbox").count(), 0);
});
