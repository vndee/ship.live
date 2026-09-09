# Service Health Implementation Plan

> Execute in this session using subagent-driven-development for independent probe/UI work and local integration work.

**Goal:** Configurable public service probes with durable scheduling and live team status.
**Architecture:** Separate health storage, worker, HTTP runner, routes and UI. PostgreSQL leases coordinate replicas; SSE invalidates health snapshots independently of GitHub activity.
**Tech Stack:** Existing TypeScript, Express, PostgreSQL, React; Node HTTP(S) and DNS.
**Spec:** docs/superpowers/specs/2026-09-09-service-health-design.md

## Global constraints

Public APIs only; UI configuration; no public share exposure; encrypted secret headers; no arbitrary conditions code. Team membership and session authorization required. Bounded worker concurrency and retained history. Work on codex/service-health; no deploy/push.

## Task 1: Probe execution and validation

Files: shared/health.ts, server/health-probe.ts, server/health-probe.test.ts.
Interface: validateProbe(input): ProbeInput; runProbe(input, headers): Promise<ProbeResult>; public URL/address guards. Write rejection/equality/timeout tests, verify failing, implement guarded runner, verify passing. Pin DNS lookup to validated public addresses and preserve hostname/SNI. No redirects. 64 KB response cap. Test status/latency/JSON conditions and local network rejection.

## Task 2: Durable health state and API

Files: server/migrations/006_service_health.sql, server/postgres-store.ts, server/health-store.ts, server/health-store.test.ts, server/health-app.ts, server/health-worker.ts, server/workspace-app.ts, server/index.ts.
Consume shared types and runProbe. Produce team-scoped CRUD, claim/complete fencing, history, scheduler and SSE. First add database tests: two concurrent claims must not overlap; editing invalidates a running result; another workspace cannot mutate/read results; secrets do not appear in snapshot. Then implement migration/store, authenticated routes, worker startup/shutdown. Route tests verify CSRF and access denial. Use expiring token lease and definition invalidation, never keep transaction open during network work.

## Task 3: Team dashboard UI

Files: src/components/ServiceHealth.tsx, src/components/service-health.css, src/App.tsx.
Consume session CSRF, workspace ID and health endpoints. Produce independent health loading, configuration form, live status and history. Scope/unmount cancels requests; reject late mutation responses. Browser-test empty state, create/edit, field errors, pause/resume, delete, live transitions, mobile and reduced motion.

## Task 4: Integration and review

Run full database tests, npm run build, npm run format:check. Review SSRF/auth/lease/UI integration, fix discovered issues and rerun covering tests. Write user configuration docs and evidence. Leave feature local for review.

## Implementation evidence

- Probe runner + validation implemented with tests for SSRF, DNS pinning, TLS hostname, status/JSON/latency and absolute deadlines.
- Migration/store/routes/worker implemented; database tests cover tenant isolation, encryption, leases, pause/history, key replacement, SSE and worker lifecycle.
- Team-only UI implemented and browser-checked at desktop and mobile widths: create, validation errors, edit, headers preserve/remove, pause/resume and live down/recovery timeline.
- Independent review findings fixed: history loss on administrative edits, editor completion race, repair of unreadable encrypted headers.
- Updated user requirement: at least 30-day retention, recent 120 check strip/timeline and daily latency chart; changing measurement rules resets current state while preserving history.

## Follow-up: dedicated tab and health sharing

User requested Service Health as its own tab and shareable like the dashboard. Implemented separate navigation and anonymous `/share/health#token` page, independent share storage/migration and explicit public field allowlist. Current and future service names/status/history are shared; targets, headers and conditions remain private. Create/rotate/revoke browser-verified with live viewers; old links clear immediately. 152 database/unit tests pass, including token namespace isolation, final-read revocation and creator access loss. Build and format checks pass.

## Final verification

161 unit and PostgreSQL integration tests pass. Public Open-Meteo forecast checks verified scheduled HTTP/JSON success, deliberate condition failure, recovery and retained latency data. Independent review findings on final-read authorization and SSE upstream request load are fixed with regressions. Daily rollups update transactionally; migration backfills existing results.
