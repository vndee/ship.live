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
    import {useFeed} from './src/hooks/useFeed';
    import {navigate} from './src/hooks/useRoute';
    import {aggregatePulse,resolvePulseRange} from './shared/pulse';
    window.navigate = navigate; window.aggregatePulse=aggregatePulse; window.resolvePulseRange=resolvePulseRange;
    const suspended = new Promise(() => {});
    function SuspenseProbe() {
      const feed = useFeed();
      if (new URLSearchParams(location.search).get('workspace') === 'team-b') {
        window.suspendedRenders = (window.suspendedRenders || 0) + 1;
        throw suspended;
      }
      return <output>{feed.workspace?.id || 'demo'}</output>;
    }
    createRoot(document.getElementById('root')).render(window.suspenseProbe ? <React.Suspense fallback={<p>Suspended</p>}><SuspenseProbe/></React.Suspense> : <App/>);
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
async function open(
  t,
  path = digest,
  signedIn = true,
  events = [],
  options = {},
) {
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
    window.workspaceReplies = [];
    window.workspaces = [
      { id: "personal-a", name: "Journal", kind: "personal", owner: true },
      { id: "team-a", name: "Digest Team", kind: "team", owner: false },
      { id: "team-b", name: "Second Team", kind: "team", owner: false },
    ];
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      });
    window.fetch = async (path) => {
      window.requests.push(path);
      if (path === "/api/session")
        return json({
          user: window.signedIn
            ? {
                id: window.userId || "user-a",
                name: "Alice",
                email: "alice@example.invalid",
              }
            : null,
          providers: { github: true, google: true },
          configured: true,
          csrfToken: "test",
        });
      if (path === "/api/workspaces") {
        const status = window.workspaceStatus || 200;
        const response = json(
          status === 200
            ? {
                workspaces: window.workspaces,
                githubConnected: true,
                githubAppConfigured: true,
              }
            : { error: "Workspace service temporarily unavailable" },
          status,
        );
        if (window.holdWorkspaces)
          return new Promise((resolve) =>
            window.workspaceReplies.push(() => resolve(response)),
          );
        return response;
      }
      if (path.includes("/pulse/activity?"))
        return json({ events: [], nextCursor: null });
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
    ({ signedIn, events, options }) => {
      window.signedIn = signedIn;
      window.dashboardEvents = events;
      Object.assign(window, options);
    },
    { signedIn, events, options },
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

test("a failed initial workspace lookup offers retry without claiming membership is missing", async (t) => {
  const page = await open(t, digest, true, [], { workspaceStatus: 503 });
  await page
    .getByRole("heading", { name: "Could not load workspace" })
    .waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "Workspace unavailable" }).count(),
    0,
  );
  assert.equal(
    await page.evaluate(() =>
      window.requests.some((p) => p.startsWith("/api/workspaces/")),
    ),
    false,
  );
  await page.evaluate(() => {
    window.workspaceStatus = 200;
  });
  await page.getByRole("button", { name: "Retry workspace access" }).click();
  await selected(page, "Review radar");
  assert.equal(new URL(page.url()).searchParams.get("workspace"), "team-a");
  assert.equal(new URL(page.url()).searchParams.get("from"), "2026-09-07");
});

for (const status of [403, 503, 500]) {
  test(`a workspace lookup ${status} recovers fresh dashboard data after retry`, async (t) => {
    const page = await open(t, digest.replace("scene=review", "scene=pulse"));
    await page.waitForFunction(
      () => document.querySelector("[data-pulse-total]")?.textContent === "0",
    );
    const before = await page.evaluate(
      () =>
        window.requests.filter((path) => path.includes("/pulse/dashboard?"))
          .length,
    );
    await page.evaluate((status) => {
      window.workspaceStatus = status;
      window.dispatchEvent(new Event("focus"));
    }, status);
    await page
      .getByRole("heading", { name: "Could not load workspace" })
      .waitFor();
    assert.equal(
      await page.getByRole("navigation", { name: "Wall scenes" }).count(),
      0,
    );
    await page.evaluate(() => {
      window.workspaceStatus = 200;
      window.dashboardEvents = [
        {
          id: "fresh-merge",
          type: "merge",
          actor: { login: "alice" },
          repo: "team/repo",
          title: "Freshly authorized shipment",
          occurredAt: "2026-09-09T12:00:00Z",
          number: 1,
        },
      ];
    });
    await page.getByRole("button", { name: "Retry workspace access" }).click();
    await page.waitForFunction(
      (before) =>
        window.requests.filter((path) => path.includes("/pulse/dashboard?"))
          .length > before,
      before,
    );
    await page.waitForFunction(
      () => document.querySelector("[data-pulse-total]")?.textContent === "1",
    );
    assert.equal(
      await page.evaluate(() =>
        window.requests.some(
          (path) => path.includes("/personal-a/") || path.includes("/team-b/"),
        ),
      ),
      false,
    );
  });
}

test("an old account's successful lookup cannot replace the new account's retryable failure", async (t) => {
  const page = await open(t);
  await selected(page, "Review radar");
  await page.evaluate(() => {
    window.holdWorkspaces = true;
    window.dispatchEvent(new Event("focus"));
  });
  await page.waitForFunction(() => window.workspaceReplies.length === 1);
  await page.evaluate(() => {
    window.userId = "user-b";
    window.holdWorkspaces = false;
    window.workspaceStatus = 503;
    window.workspaces = [];
    window.dispatchEvent(new Event("focus"));
  });
  await page
    .getByRole("heading", { name: "Could not load workspace" })
    .waitFor();
  await page.evaluate(async () => {
    window.workspaceReplies[0]();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  assert.equal(
    await page
      .getByRole("heading", { name: "Could not load workspace" })
      .count(),
    1,
  );
  assert.equal(
    await page.getByRole("navigation", { name: "Wall scenes" }).count(),
    0,
  );
  await page.evaluate(() => {
    window.workspaceStatus = 200;
  });
  await page.getByRole("button", { name: "Retry workspace access" }).click();
  await page.getByRole("heading", { name: "Workspace unavailable" }).waitFor();
});

test("historical drill-down remains tied to its workspace when opened again", async (t) => {
  const page = await open(t, digest.replace("scene=review", "scene=pulse"));
  await page
    .getByRole("button", { name: "View activity in this period" })
    .click();
  const location = new URL(page.url());
  assert.equal(location.pathname, "/feed");
  assert.equal(location.searchParams.get("workspace"), "team-a");
  assert.equal(location.searchParams.get("from"), "2026-09-07");
  assert.equal(location.searchParams.get("to"), "2026-09-13");
  const fresh = await open(t, location.pathname + location.search);
  await fresh.waitForFunction(() =>
    window.requests.some((p) => p.includes("/team-a/pulse/activity?")),
  );
  assert.equal(
    await fresh.evaluate(() =>
      window.requests.some((p) => p.includes("/personal-a/")),
    ),
    false,
  );
});

test("a discarded route render cannot steer an in-flight workspace refresh", async (t) => {
  const page = await open(t, digest, true, [], { suspenseProbe: true });
  await page.waitForFunction(
    () => document.querySelector("output")?.textContent === "team-a",
  );
  await page.evaluate(() => {
    window.holdWorkspaces = true;
    window.dispatchEvent(new Event("focus"));
  });
  await page.waitForFunction(() => window.workspaceReplies.length === 1);
  await page.evaluate(() =>
    window.navigate({ page: "pulse", workspace: "team-b" }),
  );
  await page.waitForFunction(() => window.suspendedRenders > 0);
  await page.evaluate(async () => {
    window.workspaceReplies[0]();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  // Cancel the suspended navigation, retaining the last committed workspace.
  await page.evaluate(() => window.navigate({ page: "pulse" }));
  await page.waitForFunction(
    () => document.querySelector("output")?.textContent !== "demo",
  );
  assert.equal(await page.locator("output").textContent(), "team-a");
});

test("Overview comparison opens type-filtered history and retains workspace when returning", async (t) => {
  const page = await open(
    t,
    "/?workspace=team-a&period=custom&from=2026-09-07&to=2026-09-13",
  );
  await page
    .getByRole("button", {
      name: "View previous period merges: 0",
      exact: true,
    })
    .click();
  await page.waitForFunction(() =>
    window.requests.some(
      (path) =>
        path.includes("/team-a/pulse/activity?") && path.includes("kind=merge"),
    ),
  );
  const url = new URL(page.url());
  assert.equal(url.pathname, "/feed");
  assert.equal(url.searchParams.get("workspace"), "team-a");
  assert.equal(url.searchParams.get("type"), "merge");
  assert.equal(url.searchParams.get("from"), "2026-08-31");
  assert.equal(url.searchParams.get("to"), "2026-09-06");
  await page
    .getByRole("button", { name: "← Back to Overview", exact: true })
    .click();
  assert.equal(new URL(page.url()).searchParams.get("workspace"), "team-a");
  await selected(page, "Overview");
});

test("Weekly recap navigation retains workspace and explicit week through Back", async (t) => {
  const page = await open(t, "/?workspace=team-a");
  await selected(page, "Overview");
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = async (path, init) => {
      if (String(path).includes("/recap")) {
        window.requests.push(path);
        const week =
          new URL(path, location.origin).searchParams.get("week") ||
          "2026-09-07";
        return new Response(
          JSON.stringify({
            workspaceName: "Digest Team",
            weekStart: week,
            weekEnd: week === "2026-09-07" ? "2026-09-13" : "2026-09-06",
            checkedAt: "2026-09-15T00:00:00Z",
            totals: {
              merges: 3,
              reviews: 2,
              releases: 1,
              contributors: 2,
              xp: 120,
            },
            shipped: [],
            helpfulReviewers: [],
            needsHelp: [],
            reflection: "Private reflection",
            schedule: { weekday: 1, time: "09:00", timezone: "UTC" },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return original(path, init);
    };
  });
  await page.getByRole("link", { name: "Weekly recap", exact: true }).click();
  await page
    .getByRole("heading", { name: "Shipped highlights", exact: true })
    .waitFor();
  assert.equal(new URL(page.url()).pathname, "/recap");
  assert.equal(new URL(page.url()).searchParams.get("workspace"), "team-a");
  await page
    .getByRole("button", { name: "Previous week", exact: true })
    .click();
  await page.waitForFunction(() => location.search.includes("week=2026-08-31"));
  await page.goBack();
  await page.getByLabel("Week starting", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Week starting", { exact: true }).inputValue(),
    "2026-09-07",
  );
  assert.equal(
    await page.evaluate(() =>
      window.requests.some((path) => path.includes("/personal-a/recap")),
    ),
    false,
  );
});

test("a saved Delivery environment stays explicit when unavailable", async (t) => {
  const page = await open(
    t,
    "/?workspace=team-a&scene=delivery&env=production",
  );
  await selected(page, "Delivery");
  await page
    .getByText(/No stored deployments for production in this view/)
    .waitFor();
  assert.equal(new URL(page.url()).searchParams.get("env"), "production");
  await page.getByRole("button", { name: /^Period:/ }).click();
  await page.getByRole("option", { name: "Today", exact: true }).click();
  assert.equal(new URL(page.url()).searchParams.get("env"), "production");
  await selected(page, "Delivery");
});
