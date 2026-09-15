import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright"
);
let browser, script;
before(async () => {
  const built = await build({
    stdin: {
      contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {EngineeringWall} from './src/components/EngineeringWall';
 const now=Date.parse('2026-09-15T12:00:00Z');const snapshot={updatedAt:'2026-09-15T12:00:00Z',repositories:[{repositoryId:101,repository:'team/api',pullRequests:[],reviews:[],pipelines:[],deployments:[{id:'prod',environment:'production',headSha:'a',status:'successful',updatedAt:'2026-09-14T00:00:00Z'},{id:'stage',environment:'staging',headSha:'b',status:'failing',updatedAt:'2026-09-14T00:00:00Z'}]}]};
 function App(){const [environment,setEnvironment]=useState('staging');const[controlled,setControlled]=useState(true);const[keepRequested,setKeepRequested]=useState(false);window.setKeepRequested=setKeepRequested;window.selectEnvironment=setEnvironment;window.setControlled=setControlled;window.changes=window.changes||[];return <EngineeringWall snapshot={snapshot} events={[]} now={now} demo={false} moving={false} autoplayDefault={false} status='Live' loading={false} requestedScene='delivery' environment={controlled||keepRequested?environment:undefined} onEnvironmentChange={controlled?(next)=>{window.changes.push(next);setEnvironment(next);}:undefined} onToggleMotion={()=>{}} onRules={()=>{}} onMilestones={()=>{}}/>;}createRoot(document.getElementById('root')).render(<App/>);`,
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    loader: { ".css": "empty" },
  });
  script = built.outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
});
after(async () => browser?.close());
async function open(t) {
  const page = await browser.newPage();
  page.setDefaultTimeout(2000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, []);
  });
  await page.route("**/*", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("http://delivery.test");
  await page.addScriptTag({ content: script });
  return page;
}
test("Delivery uses restored environment, reports changes and resets to default when URL clears", async (t) => {
  const page = await open(t);
  await page
    .getByRole("button", { name: "Environment: staging", exact: true })
    .waitFor();
  await page.getByText("0 successful to staging", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Environment: staging", exact: true })
    .click();
  await page.getByRole("option", { name: "production", exact: true }).click();
  await page.getByText("1 successful to production", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.changes), ["production"]);
  await page.evaluate(() => window.selectEnvironment("staging"));
  await page.getByText("0 successful to staging", { exact: true }).waitFor();
  await page.evaluate(() => window.selectEnvironment(undefined));
  await page.getByText("1 successful to production", { exact: true }).waitFor();
});
test("missing saved environment is explicit and never displays another environment metrics", async (t) => {
  const page = await open(t);
  await page.evaluate(() => window.selectEnvironment("retired-production"));
  await page
    .getByText(/No stored deployments for retired-production/)
    .waitFor();
  assert.equal(
    await page.getByText("1 successful to production", { exact: true }).count(),
    0,
  );
  await page
    .getByRole("button", {
      name: "Environment: retired-production (unavailable)",
      exact: true,
    })
    .click();
  await page.getByRole("option", { name: "production", exact: true }).click();
  await page.getByText("1 successful to production", { exact: true }).waitFor();
});
test("uncontrolled shared and demo usage retains the local environment picker", async (t) => {
  const page = await open(t);
  await page.evaluate(() => window.setControlled(false));
  await page
    .getByRole("button", { name: "Environment: production", exact: true })
    .click();
  await page.getByRole("option", { name: "staging", exact: true }).click();
  await page.getByText("0 successful to staging", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.changes), []);
});

for (const requested of ["staging", "retired-production"]) {
  test(`uncontrolled picker can override requested environment ${requested}`, async (t) => {
    const page = await open(t);
    await page.evaluate((value) => {
      window.setControlled(false);
      window.setKeepRequested(true);
      window.selectEnvironment(value);
    }, requested);
    const label =
      requested === "staging" ? "staging" : "retired-production (unavailable)";
    await page
      .getByRole("button", { name: `Environment: ${label}`, exact: true })
      .click();
    await page.getByRole("option", { name: "production", exact: true }).click();
    await page
      .getByText("1 successful to production", { exact: true })
      .waitFor();
    assert.equal(await page.getByText(/No stored deployments/).count(), 0);
    assert.deepEqual(await page.evaluate(() => window.changes), []);
  });
}
