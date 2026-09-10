# Service ordering, filtered JSON paths, and workspace restoration

## Goal

Make service health configuration practical for status APIs whose component lists are arrays, let teams control the order in which services appear, and restore each signed-in user's last selected workspace after a reload.

This change extends the existing service health and workspace flows. It does not add arbitrary JSONPath execution, probe ordering, or server-side user preference storage.

## Filtered JSON paths

Probe JSON conditions continue to support dot-separated object fields and numeric array indexes. They additionally support one or more restricted equality filters using familiar JSONPath syntax:

```text
components[?(@.name=="Embeddings")].status
components[?(@.id==42)].state
regions[?(@.primary==true)].health.ready
```

Each filter operates on an array at its current path and selects the first object whose named property strictly equals a JSON primitive. Filter values may be strings, finite numbers, booleans, or null. Property names use the same bounded identifier form as ordinary path segments. String literals use JSON quoting and escaping. Existing paths such as `health.ready` and `items.0.status` remain valid.

The parser is a small purpose-built parser. It never invokes `eval`, a JavaScript expression parser, user-supplied regular expressions, or callbacks. The existing 256-character path limit remains. Parsing rejects unsupported operators, recursive descent, wildcards, slices, unions, malformed quoting, prototype-related property names, and trailing syntax. Evaluation uses own-property checks throughout. A missing field, non-array filter target, no matching item, or later traversal through a primitive yields no value and causes the existing exact-value condition to fail.

The probe editor explains both direct paths and filtered array paths. For the OpenAI status payload, the stable condition becomes:

```text
components[?(@.name=="Embeddings")].status == "operational"
```

## Persistent service order

A new migration adds a non-null integer `display_order` column to `ship_live_health_services`. Existing rows are backfilled per workspace in their current `created_at, id` order. A uniqueness constraint on `(workspace_id, display_order)` prevents ambiguous ordering.

Creating a service locks its team workspace and appends the service after the current maximum order. Deleting a service may leave gaps; reads still sort by `display_order, created_at, id`. A reorder operation compacts positions to contiguous values.

The authenticated health router adds:

```text
PUT /api/workspaces/:workspaceId/health/services/order
{ "serviceIds": ["…", "…"] }
```

The store locks the workspace and its service rows in a transaction. The payload must contain every current service ID exactly once, contain no duplicates, and contain no ID from another workspace. Reordering uses a temporary offset before assigning final positions so the uniqueness constraint cannot be violated during swaps. The completed transaction emits the existing health invalidation notification, causing private and shared views to refresh in the saved order.

## Reordering interaction

Each collapsed or expanded service row gains a drag handle. The list uses `@dnd-kit/core` and `@dnd-kit/sortable` so pointer, touch, and keyboard input share one maintained interaction model. Dragging changes only the service list; probes remain attached to their service and keep their current name order.

The UI updates the local snapshot immediately when a drop completes, then sends the complete ordered ID list to the reorder endpoint. While that save is pending, another reorder is disabled. On success, the normal health refresh confirms database order. On failure, the UI restores the pre-drag order and shows the existing action error treatment. Incoming live refreshes do not overwrite an active drag; the latest server snapshot is applied after the interaction finishes.

The drag handle has an explicit accessible label containing the service name. Keyboard users can pick up a row, move it with arrow keys, and drop or cancel it. The visual treatment remains compact so collapsed rows still maximize the number of visible services.

## Interactive latency tooltip

The existing SVG latency chart gains one active-point interaction shared by recent checks and the 30-day view. Pointer movement and touch select the nearest recorded point by horizontal position rather than requiring the user to hit a small circle. The chart shows a restrained vertical crosshair, enlarges the active point, and positions an HTML tooltip within the chart container so it cannot overflow the card.

Recent-check tooltips show local date and time, latency, pass or fail state, and HTTP status when available. Daily tooltips show the UTC date, average, minimum, maximum, and check count. Missing daily buckets are never selectable. Pointer leave and Escape dismiss the tooltip; a touch selection remains until another point is selected or dismissed.

The chart itself is one keyboard stop. Left and Right Arrow move across recorded points, Home and End jump to the first and last point, and Escape dismisses the tooltip. The active description is associated with the chart for assistive technology. Individual points do not add up to 120 tab stops. The existing latency table remains the complete non-visual representation.

Hit testing, index movement, and tooltip clamping live in pure helpers with unit tests. The interaction adds no chart dependency.

## Workspace restoration

The browser stores the last manually selected workspace ID under a key scoped to the authenticated user ID. Selection is written only after the user chooses a workspace or successfully connects a new installation. Reads and writes are wrapped so blocked browser storage never prevents the app from loading or switching workspaces.

After `/api/workspaces` returns, initial selection checks the saved ID against that freshly authorized list. If present, the matching workspace is selected. If absent or inaccessible, selection falls back to the user's personal workspace, then the first available workspace, and replaces the stale preference with the fallback. No cached workspace data is displayed before authorization completes.

Logout clears in-memory private data as it does today. The account-scoped preference may remain so the same account can resume later, while a different account cannot consume it. The old pre-authentication `pulse.organization` preference remains deleted and is never migrated.

## Data exposure and authorization

Filtered paths and expected values remain private probe configuration and are excluded from service health share payloads. The new `display_order` value does not need to be exposed; snapshots communicate order through the service array. Public share viewers receive the same ordered service array but cannot mutate it.

The reorder route uses the existing authenticated team workspace middleware, same-origin CSRF validation, current GitHub access checks, and transaction boundaries. It accepts only UUID service IDs and a maximum of 20 entries, matching the existing per-team limit.

## Validation

- Parser tests cover existing dot/index paths, filtered string/number/boolean/null values, escaped strings, missing matches, malformed syntax, prototype names, unsupported expressions, and the 256-character bound.
- Probe execution tests confirm a filtered OpenAI-style component condition passes and a missing or unhealthy component fails without storing the response body.
- Migration and store tests cover deterministic backfill, append order, atomic swaps, duplicate/missing/foreign IDs, concurrent reorder/create behavior, and identical private/shared ordering.
- UI behavior tests cover pointer and keyboard reorder, optimistic state, pending-state exclusion, rollback, and queued live refresh handling.
- Latency interaction tests cover nearest-point selection, missing daily buckets, keyboard boundaries, tooltip contents, and horizontal clamping; browser QA covers hover, touch, focus, and both chart ranges.
- Workspace selection tests cover per-user restoration, inaccessible saved IDs, logout/account changes, successful installation selection, and blocked storage.
- Run the full unit and PostgreSQL integration suite, TypeScript build, formatting checks, and browser QA at desktop and narrow viewport sizes.
