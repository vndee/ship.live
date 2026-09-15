# Pulse Date Range Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for bounded implementation and independent review.

**Goal:** Filter Overview and its detail feed by UTC dates using complete authorized stored activity.

**Architecture:** Shared date contracts serve PostgreSQL aggregation and demo calculation. Dedicated overview/activity APIs keep historical queries separate from live recognition. A range-aware Overview and paginated feed consume them.

**Tech Stack:** TypeScript, React, Express, PostgreSQL, node:test, Playwright.

**Spec:** ../specs/2026-09-15-pulse-date-range-design.md

## Global Constraints

- UTC calendar dates, inclusive picker dates, exclusive query end; maximum 366 days.
- Never count beyond 2,000-event snapshots; aggregate SQL before returning bounded output.
- Recheck authorization after queries; shares retain pinned scope and exclude notes.
- Preserve live weekly recognition and existing rolling feed URLs.
- Work on codex/pulse-date-range; do not publish or deploy.

## Task 1: Shared contract and historical API

Files: shared/pulse.ts, shared/pulse.test.ts, server/pulse-store.ts,
server/pulse-store.test.ts, server/workspace-app.ts, server/share-app.ts,
server/pulse-api.test.ts.

Interfaces: `PulseSelection {period?: 'today'|'7d'|'30d'|'month'|'custom'; from?: string; to?: string}`;
`resolvePulseRange(selection, now)` returns `{from,to,start,end,granularity}` (ISO strings for start/end).
`PulseOverview {range, totals: {count,merges,reviews,releases}, buckets: {from,to,count,merges,reviews,releases}[], repositories: {repo,count,merges,reviews,releases}[], coverage: {earliestStoredAt: string|null,retentionDays: number|null}, generatedAt}`.
`PulseActivityPage {events: ActivityEvent[], nextCursor: string|null}`.
`aggregatePulse(events, range, now)` produces demo overview. Routes:
`GET /api/workspaces/:id/pulse/overview`, `/pulse/activity`, `/api/shared/pulse/overview`, `/api/shared/pulse/activity`.
Query selection fields above plus activity `repo`, `cursor`. Share auth uses x-dashboard-share.

- [x] Write tests for leap dates, future/reversed/oversize ranges, clipped buckets and bot exclusion. Example: `assert.throws(() => resolvePulseRange({period:'custom',from:'2026-02-30',to:'2026-03-01'}, now))`.
- [x] Run shared test and verify missing contract fails.
- [x] Implement shared contract, SQL aggregation, keyset pagination with bound cursor/cutoff.
- [x] Test >2,000 events and cross-repository isolation against real PostgreSQL, and route reauthorization/share revocation; run `node --import tsx --test shared/pulse.test.ts server/pulse*.test.ts`.

## Task 2: Overview and date URLs

Files: src/lib/routes.ts, src/lib/routes.test.ts, src/hooks/usePulse.ts,
src/components/PulseOverview.tsx, src/components/PulseRangePicker.tsx,
src/components/EngineeringWall.tsx, src/components/SharedDashboard.tsx,
src/App.tsx, src/pulse-range.css.

Consumes Task 1 contract. EngineeringWall receives optional ReactNode `overview`.
The container renders overview using authorized endpoint or demo data and keeps weekly milestone display separate.

- [x] Add failing URL tests: `assert.equal(routeHref({page:'pulse',pulsePeriod:'30d'}),'/?period=30d')`; custom dates round-trip; rolling feed links unchanged.
- [x] Implement range URL fields and picker Apply, validation and popstate restoration.
- [x] Build request hook with abort/stale result protection and coalesced live invalidation.
- [x] Render totals, daily/weekly chart and repositories; show coverage and loading/error states.
- [x] Run routes tests and `npm run check`.

## Task 3: Historical feed and browser verification

Files: src/components/PulseHistoryFeed.tsx, src/App.tsx,
src/components/SharedDashboard.tsx, src/pulse.browser.test.mjs, README.md.

Consumes PulseActivityPage. Private drill-down navigates to `/feed?from=...&to=...&repo=...`.
Shared drill-down stays on share pathname with same dates/repo and preserves token hash.

- [x] Write failing browser tests for picker, custom Apply, navigation and paginated feed with mocked authorized API data.
- [x] Render historical events with Load more, stable pagination, explicit range and no celebration observation.
- [x] Run targeted browser tests, npm test, database suite, npm run build and changed-file formatting.
- [x] Independently review full diff, repair findings and rerun affected checks.

## Progress

- Planning complete. Spec reviewed by user. Existing unrelated untracked artifacts preserved.
- Ruling: use a feature branch in the existing checkout; its tracked baseline is clean and Git writes now succeed via approved escalation. Avoid additional worktree setup churn.

- Task 1 complete: SQL aggregates and activity cursors verified against real PostgreSQL; no migration required.
- Task 2 complete: URL/picker/Overview/private and shared integration verified.
- Task 3 complete: exact-date drill-down, pagination, coverage copy, desktop/mobile checks and independent review completed.
- Review repairs: reject PostgreSQL-incompatible year zero; preserve paginated history across live refresh with scope-bound cursor probes; abort stale probes on retry.
- Final verification: `TEST_DATABASE_URL=<local-test-postgres> npm run test:db` passed 361 tests, zero skips; `node --test src/app.browser.test.mjs src/pulse.browser.test.mjs` passed 14 tests; `npm run build` and `npm run format:check` exited 0. Browser tests used the cached Playwright module and local Chromium binary via documented test environment overrides.
- Visual checks: 1440px desktop and 390px mobile, no horizontal document overflow. Build retains a Vite advisory about the main bundle exceeding 500 kB.
- Implementation retained on codex/pulse-date-range; no production deployment or remote publication.
- Main integration: merged origin/main (f0fb8e9), retained its personal EngineeringWall flow, and excluded the new alert event type from historical contribution totals. Shared alert fixture failed before the exclusion and passed after it. Merged tree verification: 378 PostgreSQL tests (zero skips), 14 browser tests, build and formatting all passed.
