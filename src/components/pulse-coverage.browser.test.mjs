import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright"
);
let browser, script, css;
before(async () => {
  const built = await build({
    stdin: {
      contents: `
      import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
      import {PulsePageFilter} from './src/components/PulsePageFilter';
      function Harness() {
        const [overview,setOverview] = useState(null); const [demo,setDemo] = useState(false);
        window.showCoverage = (data,fictional=false) => {setOverview(data); setDemo(fictional)};
        return <PulsePageFilter selection={{period:'7d'}} range={overview?.range ?? null} now={Date.parse('2026-09-15T12:00:00Z')} onChange={()=>{}} overview={overview} demo={demo}/>;
      }
      createRoot(document.getElementById('root')).render(<Harness/>);`,
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
  css = await readFile(new URL("../pulse-range.css", import.meta.url), "utf8");
  browser = await chromium.launch({ headless: true });
});
after(async () => browser?.close());
async function open(t) {
  const page = await browser.newPage({ viewport: { width: 375, height: 900 } });
  page.setDefaultTimeout(1500);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, []);
  });
  await page.route("**/*", (r) =>
    r.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("http://coverage.test/");
  await page.addStyleTag({
    content: `*{box-sizing:border-box} body{margin:16px;font-family:sans-serif;--line:#ddd;--text:#222;--muted:#555;--surface-inset:#fafafa;--accent:#87572f} ${css}`,
  });
  await page.addScriptTag({ content: script });
  return page;
}
const snapshot = (coverage, count = 0, from = "2026-09-09") => ({
  range: {
    from,
    to: "2026-09-15",
    start: from + "T00:00:00.000Z",
    end: "2026-09-16T00:00:00.000Z",
    granularity: "day",
  },
  totals: { count, merges: 0, reviews: 0, releases: 0 },
  repositories: [],
  buckets: [],
  coverage: { earliestStoredAt: null, retentionDays: null, ...coverage },
  generatedAt: "2026-09-15T12:00:00.000Z",
});
const show = (page, data, demo = false) =>
  page.evaluate(({ data, demo }) => window.showCoverage(data, demo), {
    data,
    demo,
  });

test("range coverage warns about stored history and retention while labeling the source import time accurately", async (t) => {
  const page = await open(t);
  await show(
    page,
    snapshot(
      {
        earliestStoredAt: "2026-09-10T13:00:00Z",
        retentionDays: 31,
        sourceSync: {
          lastSyncedAt: "2026-09-14T09:00:00Z",
          syncedRepositories: 1,
          totalRepositories: 2,
        },
      },
      3,
      "2026-08-01",
    ),
  );
  const coverage = page.getByRole("region", { name: "Activity data coverage" });
  await coverage.waitFor();
  assert.match(await coverage.innerText(), /Limited history/);
  assert.match(await coverage.innerText(), /starts before.*2026-09-10/);
  assert.match(await coverage.innerText(), /31.day retention/);
  assert.match(await coverage.innerText(), /2026-09-14 09:00 UTC/);
  assert.match(await coverage.innerText(), /sync start/i);
  assert.match(await coverage.innerText(), /1 of 2/);
  assert.doesNotMatch(await coverage.innerText(), /2026-09-15 12:00/);
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "coverage fits mobile width",
  );
});
test("empty period differs from no stored history or no successful import, without claiming completeness", async (t) => {
  const page = await open(t);
  const coverage = page.getByRole("region", { name: "Activity data coverage" });
  await show(
    page,
    snapshot({
      earliestStoredAt: "2026-09-01T10:00:00Z",
      sourceSync: {
        lastSyncedAt: "2026-09-14T09:00:00Z",
        syncedRepositories: 1,
        totalRepositories: 1,
      },
    }),
  );
  await coverage.waitFor();
  assert.match(
    await coverage.innerText(),
    /No stored contributions in this period/,
  );
  assert.match(await coverage.innerText(), /Completeness unknown/);
  await show(
    page,
    snapshot({
      sourceSync: {
        lastSyncedAt: null,
        syncedRepositories: 0,
        totalRepositories: 1,
      },
    }),
  );
  await page
    .getByText("No stored contributions yet.", { exact: true })
    .waitFor();
  assert.match(
    await coverage.innerText(),
    /No successful source import recorded/,
  );
  await show(
    page,
    snapshot({
      sourceSync: {
        lastSyncedAt: "2026-09-14T09:00:00Z",
        syncedRepositories: 1,
        totalRepositories: 1,
      },
    }),
  );
  await page.getByText(/A source import is recorded/).waitFor();
  assert.doesNotMatch(
    await coverage.innerText(),
    /No successful source import recorded/,
  );
  await show(page, snapshot({ earliestStoredAt: "2026-09-09T12:00:00Z" }, 1));
  await page.getByText("Completeness unknown", { exact: true }).waitFor();
  assert.doesNotMatch(
    await coverage.innerText(),
    /starts before/,
    "same UTC day does not precede stored history",
  );
  assert.match(await coverage.innerText(), /Source import status unavailable/);
});
test("demo coverage stays fictional and cleared overview removes previous coverage", async (t) => {
  const page = await open(t);
  await show(
    page,
    snapshot({ earliestStoredAt: "2026-09-10T13:00:00Z" }, 12),
    true,
  );
  const coverage = page.getByRole("region", { name: "Activity data coverage" });
  await coverage.waitFor();
  assert.match(await coverage.innerText(), /Fictional demo data/);
  assert.doesNotMatch(
    await coverage.innerText(),
    /source import|Limited history/i,
  );
  await show(page, null);
  await coverage.waitFor({ state: "hidden" });
});
