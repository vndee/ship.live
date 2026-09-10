# Health Order, Filtered JSONPath, and Workspace Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe array-filtered probe conditions, database-backed service ordering with accessible drag and drop, interactive latency tooltips, and restoration of each user's last authorized workspace after reload.

**Architecture:** A purpose-built parser converts the supported JSONPath subset into typed traversal steps consumed by the health probe runner. PostgreSQL owns service order and exposes one atomic full-order mutation; the React client uses dnd-kit for optimistic sorting and rollback. Pure latency interaction helpers drive a single accessible SVG/HTML tooltip, and a small browser-storage module keeps workspace preference account-scoped and lets `useFeed` restore it only after server authorization.

**Tech Stack:** TypeScript, Node.js test runner, Express, PostgreSQL migrations and transactions, React 19, `@dnd-kit/core`, `@dnd-kit/sortable`, CSS.

**Spec:** `docs/superpowers/specs/2026-09-10-health-order-jsonpath-workspace-design.md`

## Global Constraints

- JSON paths remain limited to 256 characters and never execute code, regular expressions, or arbitrary expressions.
- Filters support strict equality against JSON string, finite number, boolean, or null values and select the first matching object.
- Existing dot paths and numeric array indexes remain compatible.
- A team has at most 20 services; a reorder payload contains every current service exactly once.
- Service order is shared by authenticated and public health snapshots; URLs, headers, paths, and expected values remain private.
- Workspace preference is scoped by authenticated user ID and is applied only after the returned workspace list authorizes the saved ID.
- Storage failures must never block app startup, logout, or workspace switching.
- The latency chart remains one keyboard stop and missing daily buckets are never interactive points.

---

### Task 1: Parse and evaluate the restricted JSONPath subset

**Files:**

- Create: `server/json-path.ts`
- Create: `server/json-path.test.ts`

**Interfaces:**

- Produces: `parseJsonPath(path: string): JsonPathStep[]`
- Produces: `readJsonPath(value: unknown, steps: JsonPathStep[]): unknown`
- Produces: `JsonPathStep = { kind: "property"; key: string } | { kind: "filter"; key: string; expected: string | number | boolean | null }`

- [ ] **Step 1: Write failing parser and evaluator tests**

```ts
test("reads fields, numeric indexes, and primitive equality filters", () => {
  const value = {
    components: [
      { name: "Responses", status: "degraded" },
      { name: "Embeddings", status: "operational" },
    ],
  };
  assert.equal(
    readJsonPath(
      value,
      parseJsonPath('components[?(@.name=="Embeddings")].status'),
    ),
    "operational",
  );
  assert.equal(
    readJsonPath({ items: [{ ok: true }] }, parseJsonPath("items.0.ok")),
    true,
  );
});

test("accepts every bounded primitive and chooses the first strict match", () => {
  assert.equal(
    readJsonPath(
      {
        v: [
          { x: 1, y: "first" },
          { x: 1, y: "second" },
        ],
      },
      parseJsonPath("v[?(@.x==1)].y"),
    ),
    "first",
  );
  assert.equal(
    readJsonPath(
      { v: [{ x: false, y: 2 }] },
      parseJsonPath("v[?(@.x==false)].y"),
    ),
    2,
  );
  assert.equal(
    readJsonPath(
      { v: [{ x: null, y: 3 }] },
      parseJsonPath("v[?(@.x==null)].y"),
    ),
    3,
  );
});

test("rejects executable, ambiguous, malformed, and prototype paths", () => {
  for (const path of [
    "components[*].status",
    'components[?(@.name!="Embeddings")].status',
    "components[?(@.name==process.exit())].status",
    "components[?(@.__proto__==null)].status",
    "constructor.value",
    "a..b",
    "x".repeat(257),
  ])
    assert.throws(() => parseJsonPath(path), /JSON path/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --import tsx --test server/json-path.test.ts`

Expected: FAIL because `server/json-path.ts` does not exist.

- [ ] **Step 3: Implement the tokenizer, parser, and evaluator**

```ts
export type JsonPrimitive = string | number | boolean | null;
export type JsonPathStep =
  | { kind: "property"; key: string }
  | { kind: "filter"; key: string; expected: JsonPrimitive };

export function parseJsonPath(path: string): JsonPathStep[] {
  if (!path || path.length > 256) throw new Error("Invalid JSON path.");
  const blocked = new Set(["__proto__", "constructor", "prototype"]);
  const steps: JsonPathStep[] = [];
  let rest = path;
  let needProperty = true;
  while (rest) {
    if (needProperty) {
      const property = /^[A-Za-z0-9_-]+/.exec(rest)?.[0];
      if (!property || blocked.has(property))
        throw new Error("Invalid JSON path.");
      steps.push({ kind: "property", key: property });
      rest = rest.slice(property.length);
      needProperty = false;
      continue;
    }
    if (rest.startsWith(".")) {
      rest = rest.slice(1);
      needProperty = true;
      continue;
    }
    const filter =
      /^\[\?\(@\.([A-Za-z0-9_-]+)==((?:"(?:\\.|[^"\\])*")|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)\)\]/.exec(
        rest,
      );
    if (!filter || blocked.has(filter[1]))
      throw new Error("Invalid JSON path.");
    const expected = JSON.parse(filter[2]) as JsonPrimitive;
    if (typeof expected === "number" && !Number.isFinite(expected))
      throw new Error("Invalid JSON path.");
    steps.push({ kind: "filter", key: filter[1], expected });
    rest = rest.slice(filter[0].length);
  }
  if (needProperty) throw new Error("Invalid JSON path.");
  return steps;
}

export function readJsonPath(value: unknown, steps: JsonPathStep[]): unknown {
  for (const step of steps) {
    if (step.kind === "property") {
      value =
        value !== null &&
        typeof value === "object" &&
        Object.hasOwn(value, step.key)
          ? (value as Record<string, unknown>)[step.key]
          : undefined;
    } else {
      value = Array.isArray(value)
        ? value.find(
            (item) =>
              item !== null &&
              typeof item === "object" &&
              Object.hasOwn(item, step.key) &&
              (item as Record<string, unknown>)[step.key] === step.expected,
          )
        : undefined;
    }
  }
  return value;
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --import tsx --test server/json-path.test.ts`

Expected: PASS for valid traversal and every rejection case.

- [ ] **Step 5: Commit the parser unit**

```bash
git add server/json-path.ts server/json-path.test.ts
git commit -m "Add safe filtered JSON path parser"
```

### Task 2: Use filtered paths in health probe validation and execution

**Files:**

- Modify: `server/health-probe.ts`
- Modify: `server/health-probe.test.ts`
- Modify: `docs/service-health.md`

**Interfaces:**

- Consumes: `parseJsonPath(path)` and `readJsonPath(value, steps)` from Task 1
- Preserves: `validateProbe(input): ProbeInput`
- Preserves: `runProbe(input, headers): Promise<ProbeResult>`

- [ ] **Step 1: Add a failing OpenAI-style component test**

```ts
test("filters status components by a stable primitive property", async () => {
  payload = JSON.stringify({
    components: [
      { name: "Chat Completions", status: "degraded" },
      { name: "Embeddings", status: "operational" },
    ],
  });
  const probe = validateProbe(
    definition({
      url: "http://example.com",
      jsonPath: 'components[?(@.name=="Embeddings")].status',
      jsonExpected: "operational",
    }),
  );
  assert.equal((await runProbe(probe, {})).ok, true);
});
```

Add these validation cases to the same test:

```ts
for (const jsonPath of [
  'components[?(@.name!="Embeddings")].status',
  "components[?(@.name==process.exit())].status",
  "components[?(@.__proto__==null)].status",
])
  assert.throws(() =>
    validateProbe(definition({ jsonPath, jsonExpected: "operational" })),
  );
```

Then replace the payload with `{"components":[]}` and assert the same probe returns `{ ok: false }` with reason `JSON condition did not match.`.

- [ ] **Step 2: Run the health probe test and verify RED**

Run: `node --import tsx --test server/health-probe.test.ts`

Expected: FAIL because `validateProbe` still rejects filter syntax.

- [ ] **Step 3: Replace regex-only validation and split traversal**

In `validateProbe`, call `parseJsonPath(jsonPath)` when non-empty and convert its parser error to `AuthError(400, "Use a supported JSON path.")`. In `runProbe`, parse the already-validated path and call `readJsonPath` instead of splitting on dots.

Update the editor copy and `docs/service-health.md` with these literal examples:

```text
health.ready
items.0.status
components[?(@.name=="Embeddings")].status
```

- [ ] **Step 4: Run parser and health probe tests**

Run: `node --import tsx --test server/json-path.test.ts server/health-probe.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit probe integration**

```bash
git add server/health-probe.ts server/health-probe.test.ts docs/service-health.md
git commit -m "Support filtered JSON health conditions"
```

### Task 3: Persist service display order atomically

**Files:**

- Create: `server/migrations/010_health_service_order.sql`
- Modify: `server/health-store.ts`
- Modify: `server/health-store.test.ts`
- Modify: `server/postgres-store.test.ts`

**Interfaces:**

- Produces: `HealthStore.reorderServices(workspaceId: string, serviceIds: string[]): Promise<void>`
- Changes: `createService` appends under the existing workspace transaction lock
- Changes: `snapshot` sorts services by saved order

- [ ] **Step 1: Write failing PostgreSQL ordering tests**

```ts
test("service order persists, is tenant safe, and new services append", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const first = await f.health.createService(f.workspace, "First");
  const second = await f.health.createService(f.workspace, "Second");
  await f.health.reorderServices(f.workspace, [second.id, first.id]);
  assert.deepEqual(
    (await f.health.snapshot(f.workspace)).services.map((s) => s.id),
    [second.id, first.id],
  );
  const third = await f.health.createService(f.workspace, "Third");
  assert.deepEqual(
    (await f.health.snapshot(f.workspace)).services.map((s) => s.id),
    [second.id, first.id, third.id],
  );
  await assert.rejects(() =>
    f.health.reorderServices(f.workspace, [first.id, first.id, third.id]),
  );
});
```

Extend the migration expectation in `server/postgres-store.test.ts` from versions `1..9` to `1..10`. Add missing-ID and foreign-workspace cases.

- [ ] **Step 2: Run the database test and verify RED**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" node --import tsx --test server/health-store.test.ts server/postgres-store.test.ts`

Expected: FAIL because migration 010 and `reorderServices` do not exist. If `TEST_DATABASE_URL` is unavailable, run the full unit suite now and retain the database cases for CI.

- [ ] **Step 3: Add migration 010**

```sql
ALTER TABLE ship_live_health_services ADD COLUMN display_order integer;

WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY workspace_id ORDER BY created_at, id) - 1 AS position
  FROM ship_live_health_services
)
UPDATE ship_live_health_services s SET display_order=ranked.position FROM ranked WHERE ranked.id=s.id;

ALTER TABLE ship_live_health_services ALTER COLUMN display_order SET NOT NULL;
ALTER TABLE ship_live_health_services ADD CONSTRAINT ship_live_health_services_workspace_order_key UNIQUE(workspace_id, display_order) DEFERRABLE INITIALLY IMMEDIATE;
```

- [ ] **Step 4: Implement append, reorder, and ordered snapshots**

Within the existing workspace lock transaction, create with `coalesce(max(display_order), -1) + 1`. For reorder, lock all rows, validate exact set equality, defer the unique constraint, and update positions with one `unnest($2::uuid[]) WITH ORDINALITY` statement. Notify only after successful validation and updates.

- [ ] **Step 5: Run store and migration tests**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" node --import tsx --test server/health-store.test.ts server/postgres-store.test.ts`

Expected: PASS, or explicit database skips when the isolated test URL is not configured.

- [ ] **Step 6: Commit persistence**

```bash
git add server/migrations/010_health_service_order.sql server/health-store.ts server/health-store.test.ts server/postgres-store.test.ts
git commit -m "Persist service health display order"
```

### Task 4: Expose the authorized reorder endpoint

**Files:**

- Modify: `server/health-app.ts`
- Modify: `server/workspace-app.test.ts`

**Interfaces:**

- Consumes: `HealthStore.reorderServices(workspaceId, serviceIds)` from Task 3
- Produces: `PUT /api/workspaces/:id/health/services/order` with `{ serviceIds: string[] }`, returning HTTP 204

- [ ] **Step 1: Add failing route authorization and mutation tests**

Extend the existing `team health UI routes enforce access and CSRF` test with two services and these assertions:

```ts
const another = await (
  await mutate("/services", "POST", { name: "Worker" })
).json();
assert.equal(
  (
    await mutate("/services/order", "PUT", {
      serviceIds: [another.id, service.id],
    })
  ).status,
  204,
);
assert.deepEqual(
  (await (await request(base)).json()).services.map(
    (item: { id: string }) => item.id,
  ),
  [another.id, service.id],
);
assert.equal(
  (
    await mutate("/services/order", "PUT", {
      serviceIds: [service.id, service.id],
    })
  ).status,
  400,
);
assert.equal(
  (
    await request(`${base}/services/order`, users[0], {
      method: "PUT",
      headers: { "x-csrf-token": "invalid" },
      body: JSON.stringify({ serviceIds: [service.id, another.id] }),
    })
  ).status,
  403,
);
```

Create a service in a second connected workspace, include its ID in the first workspace's order payload, expect 400, and assert both snapshots retain their prior order.

- [ ] **Step 2: Run the workspace route test and verify RED**

Run: `node --import tsx --test --test-name-pattern="team health UI routes" server/workspace-app.test.ts`

Expected: FAIL with 404 for the new route.

- [ ] **Step 3: Add the route before `/:serviceId` routes**

```ts
router.put(`${base}/services/order`, async (req, res) => {
  const principal = await auth.requireMutation(req, res);
  await access(principal, req.params.id);
  await health.reorderServices(req.params.id, req.body?.serviceIds);
  await auth.assertActive(principal);
  res.sendStatus(204);
});
```

Validate the body inside `reorderServices` so direct store callers and routes share the same tenant-safe contract.

- [ ] **Step 4: Run the focused route test**

Run: `node --import tsx --test --test-name-pattern="team health UI routes" server/workspace-app.test.ts`

Expected: PASS, or the existing PostgreSQL skip when no isolated database URL is configured.

- [ ] **Step 5: Commit the endpoint**

```bash
git add server/health-app.ts server/workspace-app.test.ts
git commit -m "Add service health reorder endpoint"
```

### Task 5: Add optimistic accessible drag and drop

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/lib/service-order.ts`
- Create: `src/lib/service-order.test.ts`
- Create: `src/components/SortableHealthService.tsx`
- Modify: `src/components/ServiceHealth.tsx`
- Modify: `src/components/service-health.css`

**Interfaces:**

- Produces: `moveService<T extends { id: string }>(services: T[], activeId: string, overId: string): T[]`
- Produces: `SortableHealthService` wrapper that supplies drag handle attributes, listeners, transform, transition, and dragging state
- Consumes: `PUT ${base}/services/order` from Task 4

- [ ] **Step 1: Write failing immutable ordering tests**

```ts
test("moves a service without mutating the server snapshot", () => {
  const original = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(
    moveService(original, "c", "a").map((x) => x.id),
    ["c", "a", "b"],
  );
  assert.deepEqual(
    original.map((x) => x.id),
    ["a", "b", "c"],
  );
});

test("returns the same order for missing or identical targets", () => {
  const services = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(moveService(services, "a", "a"), services);
  assert.deepEqual(moveService(services, "missing", "a"), services);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --import tsx --test src/lib/service-order.test.ts`

Expected: FAIL because `moveService` does not exist.

- [ ] **Step 3: Install dnd-kit and implement the pure move helper**

Run: `npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities`

Implement `moveService` with dnd-kit's `arrayMove` after checking both IDs exist and differ.

- [ ] **Step 4: Add the sortable wrapper and integrate it with the health list**

Use `DndContext`, `PointerSensor`, `TouchSensor`, `KeyboardSensor`, `closestCenter`, `SortableContext`, and `sortableKeyboardCoordinates`. Render a `GripVertical` button labeled `Reorder ${service.name}`. Keep the existing expansion button separate so dragging never toggles a service.

On drag start, capture the current ordered services in a ref and suspend applying refresh order. On drag end:

```ts
const reordered = moveService(
  snapshot.services,
  active.id.toString(),
  over?.id.toString() ?? active.id.toString(),
);
setSnapshot((current) => current && { ...current, services: reordered });
const saved = await mutate(
  "/services/order",
  "PUT",
  { serviceIds: reordered.map((service) => service.id) },
  "Service order saved",
);
if (!saved)
  setSnapshot(
    (current) => current && { ...current, services: beforeDrag.current },
  );
```

Use the existing refresh scheduler after success. Disable sensors while another mutation is busy. Apply any queued server snapshot after drop or cancellation.

- [ ] **Step 5: Style and manually verify all input modes**

Add compact handle, dragging elevation, drop target, and focus-visible styles. Verify pointer reorder, touch emulation, Space/arrow/Space keyboard reorder, Escape cancellation, expanded row dragging, mutation rollback, and narrow viewport layout.

- [ ] **Step 6: Run unit tests and build**

Run: `node --import tsx --test src/lib/service-order.test.ts && npm run build`

Expected: PASS.

- [ ] **Step 7: Commit sortable UI**

```bash
git add package.json package-lock.json src/lib/service-order.ts src/lib/service-order.test.ts src/components/SortableHealthService.tsx src/components/ServiceHealth.tsx src/components/service-health.css
git commit -m "Add draggable service health ordering"
```

### Task 6: Add an interactive accessible latency tooltip

**Files:**

- Modify: `src/lib/latency-chart.ts`
- Modify: `src/lib/latency-chart.test.ts`
- Modify: `src/components/LatencyChart.tsx`
- Modify: `src/components/service-health.css`

**Interfaces:**

- Extends: `LatencyPoint` with `ok?: boolean` and `statusCode?: number | null`
- Produces: `nearestLatencyPoint(points: (LatencyPoint | null)[], targetTime: number): number | null`
- Produces: `moveLatencyPoint(points: (LatencyPoint | null)[], active: number | null, key: "previous" | "next" | "first" | "last"): number | null`
- Produces: `clampTooltipLeft(anchor: number, tooltipWidth: number, containerWidth: number, padding?: number): number`

- [ ] **Step 1: Write failing interaction helper tests**

```ts
const point = (time: number): LatencyPoint => ({
  time,
  latencyMs: 100,
  minLatencyMs: 100,
  maxLatencyMs: 100,
  checks: 1,
});

test("selects the nearest recorded point and skips missing days", () => {
  const points = [point(100), null, point(300), point(500)];
  assert.equal(nearestLatencyPoint(points, 360), 2);
  assert.equal(nearestLatencyPoint(points, 490), 3);
  assert.equal(nearestLatencyPoint([null, null], 200), null);
});

test("keyboard movement stays on recorded points and clamps at both ends", () => {
  const points = [point(100), null, point(300)];
  assert.equal(moveLatencyPoint(points, null, "next"), 0);
  assert.equal(moveLatencyPoint(points, 0, "next"), 2);
  assert.equal(moveLatencyPoint(points, 2, "next"), 2);
  assert.equal(moveLatencyPoint(points, 2, "previous"), 0);
  assert.equal(moveLatencyPoint(points, 0, "last"), 2);
});

test("tooltip position stays inside the chart container", () => {
  assert.equal(clampTooltipLeft(5, 120, 640), 8);
  assert.equal(clampTooltipLeft(320, 120, 640), 260);
  assert.equal(clampTooltipLeft(635, 120, 640), 512);
});
```

- [ ] **Step 2: Run the latency test and verify RED**

Run: `node --import tsx --test src/lib/latency-chart.test.ts`

Expected: FAIL because the interaction helpers do not exist.

- [ ] **Step 3: Implement the pure selection, navigation, and clamp helpers**

```ts
export function nearestLatencyPoint(
  points: (LatencyPoint | null)[],
  targetTime: number,
): number | null {
  let selected: number | null = null;
  let distance = Infinity;
  points.forEach((point, index) => {
    if (!point) return;
    const nextDistance = Math.abs(point.time - targetTime);
    if (nextDistance < distance) {
      selected = index;
      distance = nextDistance;
    }
  });
  return selected;
}

export function clampTooltipLeft(
  anchor: number,
  width: number,
  container: number,
  padding = 8,
): number {
  return Math.min(
    Math.max(padding, anchor - width / 2),
    Math.max(padding, container - width - padding),
  );
}
```

Implement `moveLatencyPoint` by deriving the non-null indexes, selecting the first point when no point is active, and clamping previous/next movement to the first and last recorded index.

- [ ] **Step 4: Preserve recent check status metadata**

When `buildLatencySeries` maps recent checks, include:

```ts
ok: check.ok,
statusCode: check.statusCode,
```

Daily points leave both fields undefined because their aggregate contains successful and failed checks.

- [ ] **Step 5: Integrate pointer, touch, and keyboard selection in `LatencyChart`**

Keep `activeIndex` in component state and clear it when mode or series changes. Make the SVG focusable with `tabIndex={0}`. Convert pointer X from its client rectangle into the chart's time domain, call `nearestLatencyPoint`, and use pointer leave to dismiss mouse hover. Handle ArrowLeft, ArrowRight, Home, End, and Escape with `moveLatencyPoint`.

Render the active point after the regular series so it stays visible:

```tsx
<line
  className="latency-crosshair"
  x1={activeX}
  x2={activeX}
  y1={26}
  y2={138}
/>
<circle
  className="latency-point is-active"
  cx={activeX}
  cy={activeY}
  r={5}
/>
```

Render one `.latency-tooltip` HTML element inside a positioned chart wrapper. Measure the wrapper and tooltip refs in a layout effect, then use `clampTooltipLeft`. Recent content includes local timestamp, rounded latency, Passed/Failed, and `HTTP ${statusCode}` when non-null. Daily content includes UTC date, average, min, max, and check count. Associate its ID with the focused SVG using `aria-describedby` while active.

- [ ] **Step 6: Style and manually verify the interaction**

Add a faint crosshair, active-point ring, compact surface tooltip, tabular numbers, and focus-visible outline. Verify hover between small points chooses the nearest point, daily gaps are skipped, tooltip stays inside both card edges, touch selection persists, pointer leave dismisses hover, and keyboard navigation works without creating per-point tab stops.

- [ ] **Step 7: Run latency tests and build**

Run: `node --import tsx --test src/lib/latency-chart.test.ts && npm run build`

Expected: PASS.

- [ ] **Step 8: Commit the chart interaction**

```bash
git add src/lib/latency-chart.ts src/lib/latency-chart.test.ts src/components/LatencyChart.tsx src/components/service-health.css
git commit -m "Add interactive latency chart tooltips"
```

### Task 7: Restore the last authorized workspace per user

**Files:**

- Create: `src/lib/workspace-preference.ts`
- Create: `src/lib/workspace-preference.test.ts`
- Modify: `src/hooks/useFeed.ts`

**Interfaces:**

- Produces: `workspacePreferenceKey(userId: string): string`
- Produces: `readWorkspacePreference(userId: string, read: (key: string) => string | null): string | null`
- Produces: `saveWorkspacePreference(userId: string, workspaceId: string, write: (key: string, value: string) => void): boolean`
- Produces: `chooseInitialWorkspace(workspaces: Workspace[], preferredId: string | null): Workspace | null`

- [ ] **Step 1: Write failing preference and selection tests**

```ts
test("restores only an authorized workspace for the current user", () => {
  const workspaces = [personal, team];
  assert.equal(chooseInitialWorkspace(workspaces, team.id)?.id, team.id);
  assert.equal(chooseInitialWorkspace(workspaces, "revoked")?.id, personal.id);
});

test("uses account-scoped keys and tolerates blocked storage", () => {
  assert.notEqual(
    workspacePreferenceKey("user-a"),
    workspacePreferenceKey("user-b"),
  );
  assert.equal(
    readWorkspacePreference("user-a", () => {
      throw new DOMException("blocked", "SecurityError");
    }),
    null,
  );
  assert.equal(
    saveWorkspacePreference("user-a", team.id, () => {
      throw new DOMException("blocked", "SecurityError");
    }),
    false,
  );
});
```

- [ ] **Step 2: Run the preference test and verify RED**

Run: `node --import tsx --test src/lib/workspace-preference.test.ts`

Expected: FAIL because the preference module does not exist.

- [ ] **Step 3: Implement the pure preference helpers**

Use a key prefix `ship-live-workspace:` plus the authenticated user ID. Catch read/write exceptions. `chooseInitialWorkspace` finds the preferred ID first, then a personal workspace, then the first entry, then null.

- [ ] **Step 4: Integrate restoration into `useFeed`**

Split selection into an internal setter and a user-facing selector. During initial `loadWorkspaces`, read the account-scoped preference and pass it to `chooseInitialWorkspace`. Save after explicit workspace selection and after `connectInstallation`; save the authorized fallback when a stale preferred ID is rejected. Do not save demo selection and do not read preferences before session identity is established.

- [ ] **Step 5: Run preference and private-state tests**

Run: `node --import tsx --test src/lib/workspace-preference.test.ts src/lib/privateFeed.test.ts`

Expected: PASS and existing identity-reset assertions remain green.

- [ ] **Step 6: Commit workspace restoration**

```bash
git add src/lib/workspace-preference.ts src/lib/workspace-preference.test.ts src/hooks/useFeed.ts
git commit -m "Restore the last selected workspace"
```

### Task 8: Complete documentation and release verification

**Files:**

- Modify: `docs/service-health.md`
- Modify: `docs/superpowers/plans/2026-09-10-health-order-jsonpath-workspace.md`

**Interfaces:**

- Verifies all interfaces from Tasks 1–7 without adding new production behavior.

- [ ] **Step 1: Update user documentation**

Document filtered path syntax, first-match behavior, exact primitive comparison, reorder persistence, shared-view ordering, interactive latency controls, and last-workspace restoration. Include the OpenAI Embeddings and Chat Completions examples.

- [ ] **Step 2: Run the full verification suite**

```bash
npm test
npm run build
npm run format:check
git diff --check
```

Expected: zero failures. PostgreSQL tests may skip only when `TEST_DATABASE_URL` is unavailable; CI must run them with its isolated database.

- [ ] **Step 3: Browser QA the complete flow**

Create three demo services, reorder them by pointer and keyboard, reload and confirm order, open a public health share and confirm the same order, configure the OpenAI-style filtered component payload, exercise recent and 30-day latency tooltips with pointer/touch/keyboard, switch to `kamilabs-ai`, reload, and confirm the workspace is restored. Revoke access or use a nonexistent saved ID and confirm the authorized fallback.

- [ ] **Step 4: Mark completed plan checkboxes and commit final documentation**

```bash
git add docs/service-health.md docs/superpowers/plans/2026-09-10-health-order-jsonpath-workspace.md
git commit -m "Document health ordering and workspace restoration"
```
