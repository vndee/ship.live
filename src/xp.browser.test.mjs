import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright"
);
let browser, script;
before(async () => {
  script = (
    await build({
      stdin: {
        contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {EventDetail} from './src/components/EventDetail'; import {ScoringRules} from './src/components/ScoringRules'; createRoot(document.getElementById('root')).render(<><ScoringRules/><EventDetail event={window.fixture} demo={true} personal={false} canDelete={false} displayName={x=>x} onDelete={()=>{}}/></>);`,
        resolveDir: fileURLToPath(new URL("../", import.meta.url)),
        loader: "tsx",
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
    })
  ).outputFiles[0].text;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  });
});
after(async () => browser?.close());
for (const captured of [true, false])
  test(`merge evidence ${captured ? "captured" : "missing"} is transparent without inflating ranked XP`, async (t) => {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    t.after(() => page.close());
    await page.setContent('<div id="root"></div>');
    await page.evaluate((captured) => {
      window.fixture = {
        id: "m",
        type: "merge",
        actor: { login: "alice" },
        repo: "team/api",
        number: 1,
        title: "Fix race",
        occurredAt: "2026-09-17T10:00:00Z",
        additions: 8,
        deletions: 2,
        ...(captured
          ? {
              verification: {
                version: 2,
                capturedAt: "2026-09-17T10:00:01Z",
                peerReview: { status: "observed", reviewIds: [1] },
                ci: { status: "passing", checkIds: ["check:1"] },
              },
            }
          : {}),
      };
    }, captured);
    await page.addScriptTag({ content: script });
    await page.getByText("Verification at merge", { exact: true }).waitFor();
    const body = await page.locator("body").innerText();
    assert.match(body, /Base recognition: 30 XP/);
    assert.match(body, /Commits and PR openings earn no XP/);
    assert.match(body, /LOC describes change size/);
    if (captured) {
      assert.match(body, /Candidate bonus: 10 XP/);
      assert.match(body, /not included in rankings/);
    } else assert.match(body, /Insufficient data/);
  });
