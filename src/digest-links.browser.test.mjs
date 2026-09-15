import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright"
);
let browser, bundle;
before(async () => {
  const result = await build({
    stdin: {
      contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import App from './src/App';
    import {navigate} from './src/hooks/useRoute';
    import {aggregatePulse,resolvePulseRange} from './shared/pulse';
    window.navigate = navigate; window.aggregatePulse=aggregatePulse; window.resolvePulseRange=resolvePulseRange;
    createRoot(document.getElementById('root')).render(<App/>);
  `,
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
  bundle = result.outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
});
after(async () => browser?.close());
const digest =
  "/?workspace=team-a&period=custom&from=2026-09-07&to=2026-09-13&scene=review";
async function open(t, path = digest, signedIn = true, events = []) {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  t.after(async () => {
    await context.close();
    assert.deepEqual(errors, []);
  });
  await page.route("**/*", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("http://digest.test" + path);
  await page.evaluate(() => {
    localStorage.setItem("ship-live-workspace:user-a", "personal-a");
    localStorage.setItem(
      "ship-live:wall-tabs:team-a",
      JSON.stringify({ hidden: ["review"] }),
    );
    window.requests = [];
    window.workspaces = [
      { id: "personal-a", name: "Journal", kind: "personal", owner: true },
      { id: "team-a", name: "Digest Team", kind: "team", owner: false },
      { id: "team-b", name: "Second Team", kind: "team", owner: false },
    ];
    const json = (data) =>
      new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json" },
      });
    window.fetch = async (path) => {
      window.requests.push(path);
      if (path === "/api/session")
        return json({
          user: window.signedIn
            ? { id: "user-a", name: "Alice", email: "alice@example.invalid" }
            : null,
          providers: { github: true, google: true },
          configured: true,
          csrfToken: "test",
        });
      if (path === "/api/workspaces")
        return json({
          workspaces: window.workspaces,
          githubConnected: true,
          githubAppConfigured: true,
        });
      if (path.endsWith("/feed"))
        return json({
          events: [],
          updatedAt: "2026-09-15T00:00:00Z",
          accessScope: window.feedScope || "scope-a",
        });
      if (path.endsWith("/events")) return new Response("");
      if (path.includes("/pulse/dashboard?")) {
        const query = new URL(path, location.origin).searchParams;
        const range = window.resolvePulseRange(
          Object.fromEntries(query),
          Date.now(),
        );
        const response = json({
          range,
          overview: window.aggregatePulse(
            window.dashboardEvents,
            range,
            Date.now(),
          ),
          events: window.dashboardEvents,
          wall: { repositories: [], updatedAt: "" },
        });
        if (window.holdDashboard)
          return new Promise((resolve) => {
            window.resolveDashboard = () => resolve(response);
          });
        return response;
      }
      return json({});
    };
  });
  await page.evaluate(
    ({ signedIn, events }) => {
      window.signedIn = signedIn;
      window.dashboardEvents = events;
    },
    { signedIn, events },
  );
  await page.addScriptTag({ content: bundle });
  return page;
}
async function selected(page, name) {
  await page
    .getByRole("navigation", { name: "Wall scenes" })
    .getByRole("button", { name, exact: true })
    .waitFor();
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll('[aria-label="Wall scenes"] button')].some(
        (b) =>
          b.textContent === name && b.getAttribute("aria-current") === "page",
      ),
    name,
  );
}

test("digest selects its authorized workspace and scene even when stored preferences differ", async (t) => {
  const page = await open(t);
  await selected(page, "Review radar");
  await page.waitForFunction(() =>
    window.requests.some((p) => p.includes("/team-a/pulse/dashboard?")),
  );
  assert.equal(
    await page.evaluate(() =>
      window.requests.some((p) => p.includes("/personal-a/")),
    ),
    false,
  );
  assert.match(
    (await page.evaluate(() => window.requests)).find((p) =>
      p.includes("/pulse/dashboard?"),
    ),
    /from=2026-09-07&to=2026-09-13$/,
  );
  await page
    .getByRole("navigation", { name: "Wall scenes" })
    .getByRole("button", { name: "Release pulse", exact: true })
    .click();
  assert.equal(new URL(page.url()).searchParams.get("scene"), "release");
  await page.goBack();
  await selected(page, "Review radar");
  await page.goForward();
  await selected(page, "Release pulse");
  await page.getByRole("button", { name: /^Period:/ }).click();
  await page.getByRole("option", { name: "Today", exact: true }).click();
  assert.equal(new URL(page.url()).searchParams.get("workspace"), "team-a");
  assert.equal(new URL(page.url()).searchParams.get("scene"), "release");
  await page.goBack();
  await page.evaluate(() =>
    window.navigate(
      {
        ...Object.fromEntries(new URLSearchParams(location.search)),
        page: "pulse",
        pulsePeriod: "custom",
        person: "alice",
      },
      { overlay: true },
    ),
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await selected(page, "Release pulse");
  assert.equal(new URL(page.url()).searchParams.get("from"), "2026-09-07");
});

test("an unavailable explicit workspace never falls back to another team or sends its ID to an API", async (t) => {
  const page = await open(t, digest.replace("team-a", "hidden-team"));
  await page.getByRole("heading", { name: "Workspace unavailable" }).waitFor();
  assert.equal(
    await page.getByRole("navigation", { name: "Wall scenes" }).count(),
    0,
  );
  assert.equal(
    await page.evaluate(() =>
      window.requests.some((p) => p.startsWith("/api/workspaces/")),
    ),
    false,
  );
});

test("workspace navigation responds to Back and Forward without clearing digest dates", async (t) => {
  const page = await open(t);
  await selected(page, "Review radar");
  await page.evaluate(() =>
    window.navigate({
      page: "pulse",
      workspace: "team-b",
      scene: "leaderboard",
      pulsePeriod: "custom",
      from: "2026-09-01",
      to: "2026-09-06",
    }),
  );
  await selected(page, "Leaderboard");
  await page.waitForFunction(() =>
    window.requests.some((p) => p.includes("/team-b/pulse/dashboard?")),
  );
  await page.goBack();
  await selected(page, "Review radar");
  assert.equal(new URL(page.url()).searchParams.get("from"), "2026-09-07");
  await page.goForward();
  await selected(page, "Leaderboard");
});

test("removing access to a linked workspace hides its dashboard instead of switching teams", async (t) => {
  const page = await open(t);
  await selected(page, "Review radar");
  await page.evaluate(() => {
    window.workspaces = window.workspaces.filter((w) => w.id !== "team-a");
    window.requests = [];
    window.dispatchEvent(new Event("focus"));
  });
  await page.getByRole("heading", { name: "Workspace unavailable" }).waitFor();
  assert.equal(
    await page.getByRole("navigation", { name: "Wall scenes" }).count(),
    0,
  );
  assert.equal(
    await page.evaluate(() =>
      window.requests.some(
        (p) => p.includes("/personal-a/") || p.includes("/team-b/"),
      ),
    ),
    false,
  );
});

test("workspace and scene parameters on a share URL never switch to private routing", async (t) => {
  const page = await open(
    t,
    "/share?workspace=hidden-team&scene=review#" + "s".repeat(43),
  );
  await page.waitForFunction(() =>
    window.requests.some((p) => p === "/api/shared/feed"),
  );
  assert.equal(
    await page.evaluate(() =>
      window.requests.some(
        (p) => p.startsWith("/api/workspaces") || p === "/api/session",
      ),
    ),
    false,
  );
  assert.equal(
    await page.getByRole("navigation", { name: "Main navigation" }).count(),
    0,
  );
});

test("a direct profile digest closes onto the same workspace, dates and scene", async (t) => {
  const page = await open(t, digest + "&person=alice");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await selected(page, "Review radar");
  const query = new URL(page.url()).searchParams;
  assert.equal(query.get("workspace"), "team-a");
  assert.equal(query.get("from"), "2026-09-07");
  assert.equal(query.get("to"), "2026-09-13");
  assert.equal(query.get("person"), null);
});

test("leaving an unavailable workspace restores the account's saved workspace", async (t) => {
  const page = await open(t, digest.replace("team-a", "hidden-team"));
  await page.getByRole("button", { name: "Open your dashboard" }).click();
  await page.waitForFunction(() =>
    window.requests.some((p) => p.includes("/personal-a/pulse/dashboard?")),
  );
  assert.equal(new URL(page.url()).searchParams.get("workspace"), null);
});

test("signed-out digest offers login with its workspace, dates, and scene intact", async (t) => {
  const page = await open(t, digest, false);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const link = page.getByRole("link", { name: "Continue with Google" });
  const auth = new URL(await link.getAttribute("href"), page.url());
  assert.equal(auth.pathname, "/api/auth/google/start");
  assert.equal(
    auth.searchParams.get("returnTo"),
    "/?workspace=team-a&scene=review&period=custom&from=2026-09-07&to=2026-09-13",
  );
  assert.equal(
    await page.evaluate(() =>
      window.requests.some((p) => p.startsWith("/api/workspaces/")),
    ),
    false,
  );
  // Auth callback returns to this canonical URL; a verified session resolves the target.
  await page.evaluate((returnTo) => {
    window.signedIn = true;
    history.replaceState(null, "", returnTo);
    window.dispatchEvent(new Event("popstate"));
    window.dispatchEvent(new Event("focus"));
  }, auth.searchParams.get("returnTo"));
  await selected(page, "Review radar");
  await page.waitForFunction(() =>
    window.requests.some((p) => p.includes("/team-a/pulse/dashboard?")),
  );
});

test("a viewer can hide the active tab chosen by a digest link", async (t) => {
  const page = await open(t);
  await selected(page, "Review radar");
  await page.getByRole("button", { name: "Arrange tabs" }).click();
  const checkbox = page.getByRole("checkbox", {
    name: "Review radar",
    exact: true,
  });
  assert.equal(await checkbox.isChecked(), true);
  await checkbox.uncheck();
  assert.equal(
    await page
      .getByRole("navigation", { name: "Wall scenes" })
      .getByRole("button", { name: "Review radar", exact: true })
      .count(),
    0,
  );
  assert.notEqual(new URL(page.url()).searchParams.get("scene"), "review");
});

test("permission fingerprint change clears a frozen historical dashboard before reloading", async (t) => {
  const page = await open(
    t,
    digest.replace("scene=review", "scene=pulse"),
    true,
    [
      {
        id: "private-merge",
        type: "merge",
        actor: { login: "alice" },
        repo: "private/repo",
        title: "Private shipment",
        occurredAt: "2026-09-09T12:00:00Z",
        number: 1,
      },
    ],
  );
  await page.waitForFunction(
    () => document.querySelector("[data-pulse-total]")?.textContent === "1",
  );
  await page.evaluate(() => {
    window.feedScope = "scope-b";
    window.dashboardEvents = [];
    window.holdDashboard = true;
  });
  await page
    .getByRole("button", { name: "Refresh activity", exact: true })
    .click();
  await page.waitForFunction(
    () => typeof window.resolveDashboard === "function",
  );
  assert.equal(await page.locator("[data-pulse-total]").count(), 0);
  assert.equal(
    await page.getByText("Private shipment", { exact: true }).count(),
    0,
  );
  await page.evaluate(() => window.resolveDashboard());
  await page.waitForFunction(
    () => document.querySelector("[data-pulse-total]")?.textContent === "0",
  );
});

test("hiding a linked tab after auto-slide keeps the currently visible scene", async (t) => {
  const page = await open(t);
  await selected(page, "Review radar");
  await page.clock.install();
  await page.getByRole("button", { name: "Auto-slide", exact: true }).click();
  await page.getByRole("heading", { level: 1 }).hover();
  await page.clock.runFor(20_001);
  await selected(page, "Release pulse");
  assert.equal(new URL(page.url()).searchParams.get("scene"), "review");
  await page.getByRole("button", { name: "Arrange tabs" }).click();
  await page
    .getByRole("checkbox", { name: "Review radar", exact: true })
    .uncheck();
  assert.equal(
    await page
      .getByRole("navigation", { name: "Wall scenes" })
      .getByRole("button", { name: "Review radar", exact: true })
      .count(),
    0,
  );
  await selected(page, "Release pulse");
  assert.equal(new URL(page.url()).searchParams.get("scene"), "release");
});
