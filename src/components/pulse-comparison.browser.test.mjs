import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
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
    import {PulseOverview} from './src/components/PulseOverview';
    import {PulseHistoryFeed} from './src/components/PulseHistoryFeed';
    import {aggregatePulse,resolvePulseRange} from './shared/pulse';
    const now=Date.parse('2026-09-15T12:00:00Z');
    const events=[
      {id:'merge',type:'merge',actor:{login:'alice'},repo:'a/b',title:'Current merge',occurredAt:'2026-09-15T10:00:00Z'},
      {id:'review',type:'review',actor:{login:'bob'},repo:'a/b',title:'Current review',occurredAt:'2026-09-15T10:00:00Z'},
      {id:'release',type:'release',actor:{login:'alice'},repo:'a/b',title:'Previous release',occurredAt:'2026-09-14T10:00:00Z'},
    ];
    const data=aggregatePulse(events,resolvePulseRange({period:'today'},now),now);
    data.coverage.earliestStoredAt='2026-09-15T00:00:00Z'; data.comparison.previous.coverage=data.coverage;
    const source={enabled:true,demo:true,events}; window.historyClicks=[];
    function Harness(){ const [history,setHistory]=useState(null); const [demo,setDemo]=useState(false);
      window.showHistory=(kind)=>setHistory({from:'2026-09-15',to:'2026-09-15',kind}); window.setDemo=setDemo;
      return history ? <PulseHistoryFeed source={{...source,demo}} now={now} {...history} onBack={()=>setHistory(null)}/> :
      <PulseOverview source={{...source,demo}} now={now} result={{data,error:'',loading:false,retry:()=>{}}} onHistory={(from,to,repo,kind)=>{window.historyClicks.push({from,to,repo,kind});setHistory({from,to,repo,kind});}}/>;
    } createRoot(document.getElementById('root')).render(<Harness/>);`,
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
  css =
    (await readFile(new URL("../pulse-range.css", import.meta.url), "utf8")) +
    (await readFile(
      new URL("../pulse-comparison.css", import.meta.url),
      "utf8",
    ));
  browser = await chromium.launch({ headless: true });
});
after(async () => browser?.close());
async function open(t) {
  const page = await browser.newPage({
    viewport: { width: 375, height: 1000 },
  });
  page.setDefaultTimeout(1500);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, []);
  });
  await page.route("**/*", (r) =>
    r.request().url().includes("/api/")
      ? r.fulfill({ json: { events: [], nextCursor: null } })
      : r.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("http://comparison.test/");
  await page.addStyleTag({
    content: `*{box-sizing:border-box}body{margin:16px;font-family:sans-serif;--line:#ddd;--text:#222;--muted:#555;--surface-inset:#fafafa;--accent:#87572f}${css}`,
  });
  await page.addScriptTag({ content: script });
  return page;
}
test("comparison shows absolute deltas, distinct participants, both coverage caveats and incomplete current period", async (t) => {
  const page = await open(t);
  const comparison = page.getByRole("region", {
    name: "Previous period comparison",
  });
  await comparison.waitFor();
  const text = await comparison.innerText();
  assert.match(text, /2026-09-14/);
  assert.match(text, /2026-09-15/);
  assert.match(text, /Current period incomplete/);
  assert.equal(
    await page
      .getByRole("button", {
        name: "View current period participating contributors: 2",
        exact: true,
      })
      .count(),
    1,
  );
  assert.equal(
    await page
      .getByRole("button", {
        name: "View previous period participating contributors: 1",
        exact: true,
      })
      .count(),
    1,
  );
  assert.match(text, /Participating contributors/);
  assert.match(text, /\+1/);
  assert.match(text, /−1/);
  assert.doesNotMatch(text, /Infinity|NaN|%/);
  assert.match(text, /Current period: Completeness unknown/);
  assert.match(text, /Previous period: Limited history/);
  assert.match(text, /before.*earliest stored/i);
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page
    .getByRole("button", { name: "View current period merges: 1", exact: true })
    .click();
  assert.deepEqual(await page.evaluate(() => window.historyClicks), [
    { from: "2026-09-15", to: "2026-09-15", repo: undefined, kind: "merge" },
  ]);
});
test("demo comparison drilldown uses previous date range and filters underlying kind", async (t) => {
  const page = await open(t);
  await page.evaluate(() => window.setDemo(true));
  await page
    .getByRole("button", {
      name: "View previous period releases: 1",
      exact: true,
    })
    .click();
  await page.getByText("Previous release", { exact: true }).waitFor();
  assert.equal(
    await page.getByText("Current merge", { exact: true }).count(),
    0,
  );
  assert.match(
    await page.getByRole("region", { name: "Historical activity" }).innerText(),
    /Fictional demo/,
  );
  await page.evaluate(() => window.showHistory("merge"));
  await page.getByText("Current merge", { exact: true }).waitFor();
  assert.equal(
    await page.getByText("Current review", { exact: true }).count(),
    0,
  );
  await page.evaluate(() => window.showHistory("review"));
  await page.getByText("Current review", { exact: true }).waitFor();
  assert.equal(
    await page.getByText("Current merge", { exact: true }).count(),
    0,
  );
});
test("authenticated activity sends kind in the server query", async (t) => {
  const page = await open(t);
  let requested;
  await page.route("**/api/workspaces/*/pulse/activity?*", (route) => {
    requested = new URL(route.request().url());
    return route.fulfill({ json: { events: [], nextCursor: null } });
  });
  await page.evaluate(() => window.showHistory("review"));
  await page
    .getByText("No stored activity in this period.", { exact: true })
    .waitFor();
  assert.equal(requested.searchParams.get("kind"), "review");
});
