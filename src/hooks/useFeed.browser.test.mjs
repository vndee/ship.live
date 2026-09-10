// Run with node --test src/hooks/useFeed.browser.test.mjs. Playwright must be
// available as "playwright" or via PLAYWRIGHT_MODULE_PATH; all API data is fake.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright"
);
const personal = {
  id: "personal-a",
  name: "Journal",
  kind: "personal",
  owner: true,
};
const team = { id: "team-a", name: "Team", kind: "team", owner: false };
const another = { id: "team-other", name: "Other", kind: "team", owner: false };
const freshTeam = { ...team, name: "Freshly authorized team" };
const otherAccount = { ...personal, id: "personal-b", name: "Other journal" };
let browser;
let bundle;

before(async () => {
  const built = await build({
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { useFeed } from "./src/hooks/useFeed.ts";
        function Probe() {
          window.feed = useFeed();
          return React.createElement("div", {}, window.feed.workspace?.id || "demo");
        }
        const root = createRoot(document.getElementById("root"));
        window.unmount = () => root.unmount();
        root.render(React.createElement(Probe));
      `,
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  bundle = built.outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
});
after(async () => browser?.close());

async function fixture(t) {
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
    route.fulfill({
      contentType: "text/html",
      body: '<div id="root"></div>',
    }),
  );
  await page.goto("http://workspace.test/");
  await page.evaluate(
    ({ personal, team, another }) => {
      localStorage.setItem("ship-live-workspace:user-a", personal.id);
      window.fixture = {
        user: "user-a",
        workspaces: [personal, team, another],
        holdWorkspaces: false,
        workspaceRequests: [],
        completedWorkspaces: [],
      };
      const response = (data, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
        });
      window.fetch = async (path) => {
        const state = window.fixture;
        if (path === "/api/session")
          return response({
            user: state.user
              ? {
                  id: state.user,
                  name: state.user,
                  email: `${state.user}@example.invalid`,
                }
              : null,
            providers: { google: false, github: false },
            configured: true,
            csrfToken: "synthetic-token",
          });
        if (path === "/api/workspaces") {
          const list = (workspaces) => ({
            workspaces,
            githubConnected: true,
            githubAppConfigured: true,
          });
          if (!state.holdWorkspaces) return response(list(state.workspaces));
          return new Promise((resolve) => {
            const index = state.workspaceRequests.length;
            state.workspaceRequests.push((workspaces, status = 200) => {
              const result = response(
                status === 200 ? list(workspaces) : { error: "Refresh failed" },
                status,
              );
              const json = result.json.bind(result);
              result.json = async () => {
                const data = await json();
                state.completedWorkspaces.push(index);
                return data;
              };
              resolve(result);
            });
          });
        }
        if (path === "/api/github/installations/123/connect")
          return response({ workspace: team });
        if (path === "/api/logout") return response({});
        if (path.endsWith("/feed"))
          return response({ events: [], updatedAt: "2026-09-10T00:00:00Z" });
        if (path.endsWith("/events")) return new Response("");
        throw new Error(`Unexpected fixture request: ${path}`);
      };
    },
    { personal, team, another },
  );
  await page.addScriptTag({ content: bundle });
  await page.waitForFunction(
    () =>
      !window.feed?.sessionLoading &&
      window.feed?.workspace?.id === "personal-a",
  );
  await page.evaluate(() => {
    window.fixture.holdWorkspaces = true;
    window.pendingConnect = window.feed.connectInstallation(123).then(
      (workspace) => (window.connectResult = { ok: true, workspace }),
      (error) => (window.connectResult = { ok: false, error: error.message }),
    );
  });
  await page.waitForFunction(
    () => window.fixture.workspaceRequests.length === 1,
  );
  // Exercise the same focus handler that races with the 30-second session poll.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForFunction(
    () => window.fixture.workspaceRequests.length === 2,
  );
  return {
    page,
    async release(index, workspaces, status = 200) {
      await page.evaluate(
        ({ index, workspaces, status }) =>
          window.fixture.workspaceRequests[index](workspaces, status),
        { index, workspaces, status },
      );
      await page.waitForFunction(
        (index) => window.fixture.completedWorkspaces.includes(index),
        index,
      );
    },
    async result() {
      await page.waitForFunction(() => window.connectResult !== undefined);
      const result = await page.evaluate(() => window.pendingConnect);
      const state = await page.evaluate(() => ({
        active: window.feed.workspace?.id ?? null,
        saved: localStorage.getItem("ship-live-workspace:user-a"),
      }));
      return { result, ...state };
    },
  };
}

for (const order of ["connection-first", "focus-first"]) {
  test(`connect selects the latest authorization when refreshes finish ${order}`, async (t) => {
    const f = await fixture(t);
    for (const index of order === "connection-first" ? [0, 1] : [1, 0])
      await f.release(index, [
        personal,
        index === 0 ? team : freshTeam,
        another,
      ]);
    assert.deepEqual(await f.result(), {
      result: { ok: true, workspace: freshTeam },
      active: team.id,
      saved: team.id,
    });
  });

  test(`connect rejects a workspace absent from the latest ${order} refresh`, async (t) => {
    const f = await fixture(t);
    for (const index of order === "connection-first" ? [0, 1] : [1, 0])
      await f.release(index, index === 0 ? [personal, team] : [personal]);
    const state = await f.result();
    assert.equal(state.result.ok, false);
    assert.match(state.result.error, /Could not verify/);
    assert.equal(state.active, personal.id);
    assert.equal(state.saved, personal.id);
  });
}

test("connect cannot use a cached authorized workspace after the latest refresh fails", async (t) => {
  const f = await fixture(t);
  await f.release(0, [personal, team]);
  await f.release(1, [], 500);
  const state = await f.result();
  assert.equal(state.result.ok, false);
  assert.match(state.result.error, /Could not verify/);
  assert.equal(state.active, personal.id);
  assert.equal(state.saved, personal.id);
});

test("connect follows another refresh started while it awaits the superseding one", async (t) => {
  const f = await fixture(t);
  await f.release(0, [personal, team]);
  await f.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await f.page.waitForFunction(
    () => window.fixture.workspaceRequests.length === 3,
  );
  await f.release(1, [personal]);
  await f.release(2, [personal, freshTeam]);
  assert.deepEqual(await f.result(), {
    result: { ok: true, workspace: freshTeam },
    active: team.id,
    saved: team.id,
  });
});

for (const selection of [another, null]) {
  test(`a later explicit ${selection ? "workspace" : "demo"} selection survives joined refreshes`, async (t) => {
    const f = await fixture(t);
    await f.release(0, [personal, team, another]);
    await f.page.evaluate(
      (next) => window.feed.selectWorkspace(next),
      selection,
    );
    await f.release(1, [personal, freshTeam, another]);
    assert.deepEqual(await f.result(), {
      result: { ok: true, workspace: freshTeam },
      active: selection?.id ?? null,
      saved: selection?.id ?? personal.id,
    });
  });
}

for (const change of ["account change", "account A-B-A", "logout", "unmount"]) {
  test(`a joined connection is invalidated by ${change}`, async (t) => {
    const f = await fixture(t);
    await f.release(0, [personal, team]);
    await f.page.evaluate(
      async ({ change, personal, otherAccount }) => {
        window.fixture.holdWorkspaces = false;
        if (change === "logout") await window.feed.logout();
        else if (change === "unmount") window.unmount();
        else {
          window.fixture.user = "user-b";
          window.fixture.workspaces = [otherAccount];
          await window.feed.loadSession();
          if (change === "account A-B-A") {
            window.fixture.user = "user-a";
            window.fixture.workspaces = [personal];
            await window.feed.loadSession();
          }
        }
      },
      { change, personal, otherAccount },
    );
    await f.release(1, [personal, freshTeam]);
    const state = await f.result();
    assert.equal(state.result.ok, false);
    assert.match(state.result.error, /session changed/);
    assert.equal(
      state.active,
      change === "logout"
        ? null
        : change === "account change"
          ? otherAccount.id
          : personal.id,
    );
    assert.equal(state.saved, personal.id);
  });
}
