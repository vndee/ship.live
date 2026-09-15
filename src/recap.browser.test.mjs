import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright"
);
let browser, bundle;
before(async () => {
  const built = await build({
    stdin: {
      contents: `import React from 'react';import{createRoot}from'react-dom/client';import{RecapPage}from'./src/pages/RecapPage';function Harness(){const[scope,setScope]=React.useState('scope-a');const[week,setWeek]=React.useState('2026-09-07');window.changeScope=setScope;return <RecapPage workspaceId="team" csrfToken="token" scopeKey={scope} week={week} onWeekChange={setWeek}/>};createRoot(document.getElementById('root')).render(<Harness/>);`,
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    loader: { ".css": "empty" },
  });
  bundle = built.outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
});
after(async () => browser?.close());
async function open(t) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.route("**/*", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("http://recap.test");
  await page.evaluate(() => {
    window.saved = [];
    window.held = [];
    window.fetch = async (path, init = {}) => {
      const url = new URL(path, location.origin);
      const week = url.searchParams.get("week") || "2026-09-07";
      const json = (value, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (init.method === "PUT") {
        window.saved.push({
          path,
          body: JSON.parse(init.body),
          csrf: init.headers["x-csrf-token"],
        });
        return json(JSON.parse(init.body));
      }
      const body = {
        workspaceName: "Team",
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
        shipped: [
          {
            id: "merge",
            title: "Ship search",
            repository: "org/api",
            url: "https://github.com/org/api/pull/1",
            occurredAt: "2026-09-08T00:00:00Z",
          },
        ],
        helpfulReviewers: [{ login: "bob", pullRequests: 2, reviews: 2 }],
        needsHelp: [
          {
            repository: "org/api",
            number: 2,
            title: "Checks need help",
            url: "https://github.com/org/api/pull/2",
            state: "failing",
          },
        ],
        reflection: "Private lesson",
        schedule: { weekday: 1, time: "09:00", timezone: "UTC" },
      };
      if (window.hold)
        return new Promise((resolve) =>
          window.held.push(() =>
            resolve(json({ ...body, shipped: [], reflection: "" })),
          ),
        );
      return json(body);
    };
  });
  await page.addScriptTag({ content: bundle });
  await page.getByRole("heading", { name: "Shipped highlights" }).waitFor();
  return page;
}
test("recap navigates weeks, edits private reflection, exports selected week and configures local digest schedule", async (t) => {
  const page = await open(t);
  assert.equal(await page.getByText("Ship search", { exact: true }).count(), 1);
  assert.match(await page.locator("body").innerText(), /Current needs help/);
  await page
    .getByLabel("What mattered or what you learned")
    .fill("We learned from customer feedback");
  await page
    .getByRole("button", { name: "Save reflection", exact: true })
    .click();
  await page.getByText("Reflection saved.", { exact: true }).waitFor();
  await page.getByLabel("Digest day").selectOption("2");
  await page.getByLabel("Digest time", { exact: true }).fill("16:30");
  await page.getByLabel("Digest timezone").fill("Asia/Ho_Chi_Minh");
  await page
    .getByRole("button", { name: "Save schedule", exact: true })
    .click();
  await page.getByText("Schedule saved.", { exact: true }).waitFor();
  const saved = await page.evaluate(() => window.saved);
  assert.deepEqual(
    saved.map((i) => i.body),
    [
      { week: "2026-09-07", reflection: "We learned from customer feedback" },
      { weekday: 2, time: "16:30", timezone: "Asia/Ho_Chi_Minh" },
    ],
  );
  assert.ok(saved.every((i) => i.csrf === "token"));
  assert.equal(
    await page
      .getByRole("link", { name: "Export Markdown" })
      .getAttribute("href"),
    "/api/workspaces/team/recap/export?week=2026-09-07",
  );
  await page.getByRole("button", { name: "Previous week" }).click();
  await page.waitForFunction(
    () => document.querySelector("input[type=date]")?.value === "2026-08-31",
  );
  assert.match(
    await page
      .getByRole("link", { name: "Export Markdown" })
      .getAttribute("href"),
    /week=2026-08-31/,
  );
});
test("changing permission scope clears private content immediately while the replacement recap is pending", async (t) => {
  const page = await open(t);
  await page.evaluate(() => {
    window.hold = true;
    window.changeScope("scope-b");
  });
  await page.waitForFunction(() => window.held.length === 1);
  assert.equal(await page.getByText("Ship search", { exact: true }).count(), 0);
  assert.equal(
    await page.getByLabel("What mattered or what you learned").count(),
    0,
  );
  await page.evaluate(() => window.held[0]());
  await page.getByRole("heading", { name: "Shipped highlights" }).waitFor();
  assert.equal(
    await page.getByLabel("What mattered or what you learned").inputValue(),
    "",
  );
});

test("export waits for reflection changes to be saved and invalid dates explain the completed-week requirement", async (t) => {
  const page = await open(t);
  await page
    .getByLabel("What mattered or what you learned")
    .fill("An unsaved learning");
  assert.equal(
    await page.getByRole("link", { name: "Export Markdown" }).count(),
    0,
  );
  await page
    .getByText("Save your reflection before exporting.", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Save reflection", exact: true })
    .click();
  await page.getByRole("link", { name: "Export Markdown" }).waitFor();
  await page.getByLabel("Week starting", { exact: true }).fill("2026-09-08");
  await page
    .getByRole("alert")
    .filter({ hasText: "Choose a completed week starting on Monday." })
    .waitFor();
  assert.equal(
    await page.getByLabel("Week starting", { exact: true }).inputValue(),
    "2026-09-07",
  );
  await page.getByLabel("Week starting", { exact: true }).fill("2026-08-31");
  await page.getByRole("link", { name: "Export Markdown" }).waitFor();
  assert.equal(await page.getByRole("alert").count(), 0);
});

test("a revoked-access mutation clears previously loaded private recap content", async (t) => {
  const page = await open(t);
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = (url, init = {}) =>
      init.method === "PUT"
        ? Promise.resolve(
            new Response(
              JSON.stringify({
                error: "Repository access changed. Reload the recap.",
              }),
              { status: 403, headers: { "content-type": "application/json" } },
            ),
          )
        : original(url, init);
  });
  await page
    .getByRole("button", { name: "Save reflection", exact: true })
    .click();
  await page
    .getByText("Repository access changed. Reload the recap.", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByText("Ship search", { exact: true }).count(),
    0,
    "private repository content must clear when the server rejects current access",
  );
  assert.equal(
    await page.getByLabel("What mattered or what you learned").count(),
    0,
  );
});

test("expired-session schedule save hides stale recap while ordinary validation errors preserve the draft", async (t) => {
  const page = await open(t);
  await page
    .getByLabel("What mattered or what you learned")
    .fill("Keep my unsaved draft");
  await page.evaluate(() => {
    const original = window.fetch;
    window.mutationStatus = 400;
    window.fetch = (url, init = {}) =>
      init.method === "PUT"
        ? Promise.resolve(
            new Response(
              JSON.stringify({
                error:
                  window.mutationStatus === 400
                    ? "Invalid schedule."
                    : "Session expired.",
              }),
              {
                status: window.mutationStatus,
                headers: { "content-type": "application/json" },
              },
            ),
          )
        : original(url, init);
  });
  await page
    .getByRole("button", { name: "Save schedule", exact: true })
    .click();
  await page.getByText("Invalid schedule.", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("What mattered or what you learned").inputValue(),
    "Keep my unsaved draft",
  );
  assert.equal(await page.getByText("Ship search", { exact: true }).count(), 1);
  await page.evaluate(() => {
    window.mutationStatus = 401;
    window.hold = true;
  });
  await page
    .getByRole("button", { name: "Save schedule", exact: true })
    .click();
  await page.getByText("Session expired.", { exact: true }).waitFor();
  assert.equal(await page.getByText("Ship search", { exact: true }).count(), 0);
  assert.equal(
    await page.getByLabel("What mattered or what you learned").count(),
    0,
  );
  await page.getByRole("button", { name: "Retry recap", exact: true }).click();
  await page.waitForFunction(() => window.held.length === 1);
  assert.equal(await page.getByText("Ship search", { exact: true }).count(), 0);
  await page.evaluate(() => window.held[0]());
  await page.getByRole("heading", { name: "Shipped highlights" }).waitFor();
  assert.equal(
    await page.getByLabel("What mattered or what you learned").inputValue(),
    "",
  );
});
