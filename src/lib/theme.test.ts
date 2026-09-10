import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import {
  THEME_STORAGE_KEY,
  applyTheme,
  nextTheme,
  resolveTheme,
  saveTheme,
  themeColor,
} from "./theme";
import * as themeModule from "./theme";

test("saved theme takes precedence over the system preference", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});

test("missing or invalid preferences follow the system preference", () => {
  assert.equal(resolveTheme(null, true), "dark");
  assert.equal(resolveTheme(null, false), "light");
  assert.equal(resolveTheme("sepia", true), "dark");
});

test("theme toggle alternates between light and dark", () => {
  assert.equal(nextTheme("dark"), "light");
  assert.equal(nextTheme("light"), "dark");
});

test("browser chrome follows the active theme", () => {
  assert.equal(themeColor("dark"), "#090c10");
  assert.equal(themeColor("light"), "#f5f7f6");
});

test("applying and saving a theme updates the page contract", () => {
  const root = {
    dataset: {} as Record<string, string>,
    style: { colorScheme: "" },
  };
  const values = new Map<string, string>();
  const writeTheme = (key: string, value: string) => values.set(key, value);

  applyTheme("light", root);
  const saved = saveTheme("light", writeTheme);

  assert.equal(root.dataset.theme, "light");
  assert.equal(root.style.colorScheme, "light");
  assert.equal(saved, true);
  assert.equal(values.get(THEME_STORAGE_KEY), "light");
});

test("theme loading falls back when browser storage is blocked", () => {
  const loadTheme = (themeModule as Record<string, unknown>).loadTheme;
  assert.equal(typeof loadTheme, "function");
  if (typeof loadTheme !== "function") return;

  assert.equal(
    loadTheme(() => {
      throw new DOMException("Access denied", "SecurityError");
    }, false),
    "light",
  );
});

test("theme saving is non-fatal when browser storage is blocked", () => {
  assert.equal(
    saveTheme("dark", () => {
      throw new DOMException("Access denied", "SecurityError");
    }),
    false,
  );
});

test("the pre-paint bootstrap applies a saved theme before the app module", () => {
  const bootstrapPath = fileURLToPath(
    new URL("../../public/theme-init.js", import.meta.url),
  );
  assert.equal(existsSync(bootstrapPath), true);
  if (!existsSync(bootstrapPath)) return;

  const root = {
    dataset: {} as Record<string, string>,
    style: { colorScheme: "" },
  };
  let browserChromeColor = "";
  const document = {
    documentElement: root,
    querySelector() {
      return {
        setAttribute(_name: string, value: string) {
          browserChromeColor = value;
        },
      };
    },
  };
  const window = {
    localStorage: { getItem: () => "light" },
    matchMedia: () => ({ matches: true }),
  };

  runInNewContext(readFileSync(bootstrapPath, "utf8"), { document, window });

  assert.equal(root.dataset.theme, "light");
  assert.equal(root.style.colorScheme, "light");
  assert.equal(browserChromeColor, "#f5f7f6");

  const html = readFileSync(
    fileURLToPath(new URL("../../index.html", import.meta.url)),
    "utf8",
  );
  const bootstrapIndex = html.indexOf('src="/theme-init.js"');
  const appIndex = html.indexOf('src="/src/main.tsx"');
  assert.ok(bootstrapIndex >= 0 && bootstrapIndex < appIndex);
});
