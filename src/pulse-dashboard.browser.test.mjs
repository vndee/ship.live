import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright"
);
let browser, script;
before(async () => {
  const built = await build({
    stdin: {
      contents: `
    import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {usePulseDashboard} from './src/hooks/usePulseDashboard';
    import {usePulseLocation, setPulseLocation} from './src/hooks/usePulse';
    import {PulsePageFilter} from './src/components/PulsePageFilter';
    function Harness() {
      const [source,setSource] = useState({workspaceId:'alpha',demo:false,events:[],enabled:true});
      window.changeScope = update => setSource(s => ({...s,...update}));
      const {selection} = usePulseLocation();
      const now = Date.parse('2026-09-15T12:00:00Z');
      const result = usePulseDashboard(source,selection,now);
      return <><PulsePageFilter selection={selection} range={result.range} now={now} onChange={setPulseLocation}/>
      {result.error ? <p role="alert">{result.error}</p> : result.loading ? <p role="status">Loading</p> : <output>{result.data.overview.totals.count}</output>}</>;
    }
    createRoot(document.getElementById('root')).render(<Harness/>);`,
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
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
async function open(t, path = "/") {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, []);
  });
  await page.route("**/*", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("http://dashboard.test" + path);
  await page.evaluate(() => {
    window.requests = [];
    // Ignore abort deliberately, proving the hook's own response guards.
    window.fetch = (url, options) =>
      new Promise((resolve) => window.requests.push({ url, options, resolve }));
    window.respond = (index, count, status = 200) =>
      window.requests[index].resolve(
        new Response(
          JSON.stringify(
            status === 200
              ? {
                  overview: { totals: { count } },
                  events: [],
                  wall: { repositories: [] },
                }
              : { error: "Access revoked." },
          ),
          { status, headers: { "content-type": "application/json" } },
        ),
      );
  });
  await page.addScriptTag({ content: script });
  return page;
}
const request = async (page, index) => {
  await page.waitForFunction((i) => window.requests.length > i, index);
  return page.evaluate(
    (i) => ({
      url: window.requests[i].url,
      headers: window.requests[i].options.headers,
    }),
    index,
  );
};
const count = async (page, value) =>
  page.waitForFunction(
    (value) => document.querySelector("output")?.textContent === String(value),
    value,
  );
test("page-wide snapshot clears on period and workspace changes and rejects stale replies", async (t) => {
  const page = await open(t);
  const initial = await request(page, 0);
  assert.match(
    initial.url,
    /alpha\/pulse\/dashboard\?period=custom&from=2026-09-09&to=2026-09-15$/,
  );
  await page.getByRole("button", { name: /^Period:/ }).click();
  await page.getByRole("option", { name: "Today", exact: true }).click();
  assert.match((await request(page, 1)).url, /from=2026-09-15&to=2026-09-15$/);
  await page.evaluate(() => window.respond(1, 42));
  await count(page, 42);
  await page.evaluate(() => window.respond(0, 9999));
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(await page.locator("output").textContent(), "42");
  await page.evaluate(() => window.changeScope({ workspaceId: "beta" }));
  await request(page, 2);
  assert.equal(await page.locator("output").count(), 0);
  await page.evaluate(() => window.changeScope({ workspaceId: "gamma" }));
  await request(page, 3);
  await page.evaluate(() => window.respond(3, 17));
  await count(page, 17);
  await page.evaluate(() => window.respond(2, 0, 403));
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(await page.locator("output").textContent(), "17");
  await page.evaluate(() => window.changeScope({ revision: "refresh" }));
  await request(page, 4);
  assert.equal(await page.locator("output").count(), 0);
  await page.evaluate(() => window.respond(4, 0, 403));
  await page.getByRole("alert").waitFor();
  assert.equal(await page.locator("output").count(), 0);
});
test("shared period requests keep token in header and disable immediately on revoked source", async (t) => {
  const page = await open(t);
  await request(page, 0);
  await page.evaluate(() =>
    window.changeScope({ shareToken: "secret-share", workspaceId: undefined }),
  );
  const shared = await request(page, 1);
  assert.match(shared.url, /^\/api\/shared\/pulse\/dashboard/);
  assert.equal(shared.headers["x-dashboard-share"], "secret-share");
  assert.ok(!shared.url.includes("secret-share"));
  await page.evaluate(() => window.respond(1, 14));
  await count(page, 14);
  await page.evaluate(() => window.changeScope({ enabled: false }));
  await page.getByRole("status").waitFor();
  assert.equal(await page.locator("output").count(), 0);
  await page.evaluate(() => window.respond(0, 100));
  assert.equal(await page.locator("output").count(), 0);
});
test("invalid page-wide dates show an error without requesting a default range", async (t) => {
  const page = await open(t, "/?period=custom&from=2026-02-30&to=2026-03-01");
  await page.getByRole("alert").waitFor();
  assert.equal(await page.evaluate(() => window.requests.length), 0);
  assert.equal(await page.locator("output").count(), 0);
});
