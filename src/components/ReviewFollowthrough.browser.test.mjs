import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright"
);
test("review controls share claim state, snooze personally, block historical actions and discard stale scope responses", async (t) => {
  const built = await build({
    stdin: {
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {ReviewFollowthrough} from './src/components/ReviewFollowthrough.tsx';import {useReviewFollowthrough} from './src/hooks/useReviewFollowthrough.ts';
 const root=createRoot(document.getElementById('root'));const targets=[{repositoryId:101,number:7}];
 function App({scope='one',historical=false}){const context={workspaceId:scope,scopeKey:scope,userId:'alice',csrfToken:'token'};const state=useReviewFollowthrough(context,targets);return <ReviewFollowthrough item={state.items[0]} loading={state.loading} error={state.error} pending={state.pending} historical={historical} userId='alice' onAction={(a,h)=>state.act(state.items[0],a,h)}/>;}
 window.render=(scope='one',historical=false)=>root.render(<App scope={scope} historical={historical}/>);window.render();`,
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    outdir: "out",
    platform: "browser",
    format: "iife",
    jsx: "automatic",
  });
  const script = built.outputFiles.find((f) => f.path.endsWith(".js")).text;
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const item = {
    repositoryId: 101,
    number: 7,
    fingerprint: "a".repeat(64),
    reasons: ["CI failing"],
    actionable: true,
    ageMs: 86400000,
    inactiveMs: 3600000,
  };
  let current = { ...item };
  let reads = 0;
  let mutationFailure = 0;
  let held;
  let releaseClaim;
  const claimGate = new Promise((resolve) => {
    releaseClaim = resolve;
  });
  await page.route("**/*", async (route) => {
    const req = route.request();
    if (!req.url().includes("/api/"))
      return route.fulfill({
        contentType: "text/html",
        body: '<div id="root"></div>',
      });
    if (req.method() === "GET") {
      reads++;
      if (req.url().includes("/held/")) {
        held = route;
        return;
      }
      return route.fulfill({ json: { items: [current], current: true } });
    }
    if (mutationFailure)
      return route.fulfill({
        status: mutationFailure,
        json: { error: "Repository access revoked." },
      });
    const body = req.postDataJSON();
    assert.equal(req.headers()["x-csrf-token"], "token");
    if (body.action === "claim") {
      await claimGate;
      current = {
        ...current,
        claim: {
          userId: "alice",
          name: "Alice",
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
      };
    }
    if (body.action === "snooze")
      current = {
        ...current,
        snoozedUntil: new Date(Date.now() + 14400000).toISOString(),
      };
    if (body.action === "unsnooze") {
      delete current.snoozedUntil;
    }
    return route.fulfill({ json: { items: [current], current: true } });
  });
  await page.goto("http://ship.test");
  await page.addScriptTag({ content: script });
  await page.getByRole("button", { name: "I'm looking", exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event("ship-live-wall")));
  await page.waitForTimeout(100);
  assert.equal(
    await page
      .getByRole("button", { name: "I'm looking", exact: true })
      .isDisabled(),
    true,
    "a poll must not re-enable a pending mutation",
  );
  releaseClaim();
  await page.getByRole("button", { name: "Release my claim" }).waitFor();
  await page.getByRole("button", { name: "Snooze for 4 hours" }).click();
  await page.getByRole("button", { name: "Show now" }).waitFor();
  await page.getByRole("button", { name: "Show now" }).click();
  await page.getByRole("button", { name: "Snooze for 4 hours" }).waitFor();
  assert.equal(reads, 1);
  await page.evaluate(() => window.render("one", true));
  await page.getByText("Switch to a current period to take action.").waitFor();
  assert.equal(await page.getByRole("button").count(), 0);
  await page.evaluate(() => window.render("held"));
  await page.getByText("Loading current review status…").waitFor();
  await page.evaluate(() => window.render("two"));
  await page.getByRole("button", { name: "Release my claim" }).waitFor();
  if (held)
    await held
      .fulfill({
        json: {
          items: [{ ...item, claim: { userId: "bob", name: "Obsolete Bob" } }],
          current: true,
        },
      })
      .catch(() => {});
  assert.equal(await page.getByText("Obsolete Bob is looking").count(), 0);
  mutationFailure = 403;
  await page
    .getByRole("button", { name: "Release my claim", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Repository access revoked." })
    .waitFor();
  assert.equal(
    await page.getByText("You are looking", { exact: true }).count(),
    0,
    "A denied mutation must clear private follow-through state",
  );
  assert.equal(
    await page.getByRole("button").count(),
    0,
    "A denied mutation must not re-enable stale actions",
  );
  mutationFailure = 0;
  await page.evaluate(() => window.dispatchEvent(new Event("ship-live-wall")));
  await page
    .getByRole("button", { name: "Release my claim", exact: true })
    .waitFor();
  current = {
    ...item,
    fingerprint: "b".repeat(64),
    reasons: ["Changes requested"],
  };
  mutationFailure = 409;
  await page
    .getByRole("button", { name: "Release my claim", exact: true })
    .click();
  await page
    .getByText("Current status: Changes requested", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByText("You are looking", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "I'm looking", exact: true })
      .count(),
    1,
    "A conflict must reload the newly observed current status",
  );
});
test("private engineering radar exposes current follow-through outside the PR link; shared radar has no controls", async (t) => {
  const built = await build({
    stdin: {
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {EngineeringWall} from './src/components/EngineeringWall.tsx';const root=createRoot(document.getElementById('root'));const snapshot={updatedAt:'',repositories:[{repositoryId:101,repository:'team/api',pullRequests:[{number:7,title:'Ship safely',url:'https://github.com/team/api/pull/7',author:'alice',headSha:'abc',state:'open',draft:false,createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-10T00:00:00Z'}],reviews:[],pipelines:[],deployments:[]}]};window.render=(privateView=true)=>root.render(<EngineeringWall snapshot={snapshot} events={[]} now={Date.now()} demo={false} moving={false} autoplayDefault={false} status='Live' loading={false} requestedScene='review' onToggleMotion={()=>{}} onRules={()=>{}} onMilestones={()=>{}} reviewContext={privateView?{workspaceId:'one',scopeKey:'one',userId:'alice',csrfToken:'token'}:undefined}/>);window.render();`,
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    outdir: "out",
    platform: "browser",
    format: "iife",
    jsx: "automatic",
  });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  let reads = 0;
  await page.route("**/*", (route) => {
    if (route.request().url().includes("/api/")) {
      reads++;
      return route.fulfill({
        json: {
          items: [
            {
              repositoryId: 101,
              number: 7,
              fingerprint: "a".repeat(64),
              reasons: ["Changes requested"],
              actionable: true,
              ageMs: 86400000,
              inactiveMs: 3600000,
            },
          ],
          current: true,
        },
      });
    }
    return route.fulfill({
      contentType: "text/html",
      body: '<div id="root"></div>',
    });
  });
  await page.goto("http://ship.test");
  await page.addScriptTag({
    content: built.outputFiles.find((f) => f.path.endsWith(".js")).text,
  });
  await page
    .getByRole("button", { name: "I'm looking", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: /Ship safely/ })
      .getByRole("button")
      .count(),
    0,
  );
  assert.equal(reads, 1);
  await page.evaluate(() => window.render(false));
  assert.equal(
    await page
      .getByRole("button", { name: "I'm looking", exact: true })
      .count(),
    0,
  );
  assert.equal(reads, 1);
});

test("a discarded review scope render cannot discard the committed scope refresh", async (t) => {
  const built = await build({
    stdin: {
      contents: `
    import React,{startTransition,useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {useReviewFollowthrough} from './src/hooks/useReviewFollowthrough.ts';
    const suspended=new Promise(()=>{});
    const targets=[{repositoryId:101,number:7}];
    function Probe({scope}) {
      const review=useReviewFollowthrough({workspaceId:scope,scopeKey:scope,userId:'alice',csrfToken:'token'},targets);
      if(scope==='two') {window.suspendedRenders=(window.suspendedRenders||0)+1;throw suspended;}
      return <output>{scope}: {review.items[0]?.reasons.join(', ')||'Loading'}</output>;
    }
    function Harness() {
      const [scope,setScope]=useState('one');
      window.go=(scope,transition=true)=>transition?startTransition(()=>setScope(scope)):setScope(scope);
      return <React.Suspense fallback={<p>Suspended</p>}><Probe scope={scope}/></React.Suspense>;
    }
    createRoot(document.getElementById('root')).render(<Harness/>);
  `,
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
  });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  const requests = [];
  let held;
  let hold = false;
  let receive;
  const received = new Promise((resolve) => {
    receive = resolve;
  });
  const item = {
    repositoryId: 101,
    number: 7,
    fingerprint: "a".repeat(64),
    reasons: ["No approval recorded"],
    actionable: true,
    ageMs: 86400000,
    inactiveMs: 3600000,
  };
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (!url.includes("/api/"))
      return route.fulfill({
        contentType: "text/html",
        body: '<div id="root"></div>',
      });
    requests.push(url);
    if (hold) {
      held = route;
      receive();
      return;
    }
    return route.fulfill({ json: { items: [item], current: true } });
  });
  await page.goto("http://ship.test");
  await page.addScriptTag({ content: built.outputFiles[0].text });
  await page.getByText("one: No approval recorded", { exact: true }).waitFor();
  hold = true;
  await page.evaluate(() => window.dispatchEvent(new Event("ship-live-wall")));
  await received;
  await page.evaluate(() => window.go("two"));
  await page.waitForFunction(() => window.suspendedRenders > 0);
  await held.fulfill({
    json: {
      items: [{ ...item, reasons: ["Changes requested"] }],
      current: true,
    },
  });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await page.evaluate(() => window.go("one", false));
  assert.equal(
    await page.locator("output").textContent(),
    "one: Changes requested",
    "a speculative scope must not cause a committed refresh to be discarded",
  );
  assert.equal(requests.length, 2);
  assert.ok(requests.every((url) => url.includes("/workspaces/one/")));
});
