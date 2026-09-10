# Engineering Utilities Wall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-input engineering wall with Review Radar, Release Pulse, What Changed, Automatic Moments, Attention Mode, and Smart Rotation from GitHub and Service Health signals.

**Architecture:** Add typed, current-state GitHub signal tables beside the immutable activity feed, normalize signed GitHub webhooks into those tables, and return one authorized wall snapshot. Pure client selectors derive scenes and attention; a small scene controller owns rotation without changing team workflows.

**Tech Stack:** TypeScript, Express, PostgreSQL, React, SSE, Node test runner, Vite.

**Spec:** `docs/superpowers/specs/2026-09-10-engineering-wall-design.md`

## Global Constraints

- GitHub is the only CI/CD source; do not add provider-specific deployment code or configuration.
- Do not create missions, tickets, assignments, messages, or required daily input.
- Store no raw webhook payloads, CI logs, annotations, source code, probe URLs, or secrets.
- Preserve repository authorization, final-read checks, share revocation, reduced motion, and first-snapshot silence.

---

### Task 1: Typed signal normalization

**Files:**

- Create: `shared/wall.ts`
- Create: `server/wall-normalize.ts`
- Test: `server/wall-normalize.test.ts`

**Interfaces:**

- Produces: `WallSignalUpdate`, `PipelineState`, `PullRequestState`, `DeploymentState`, and `normalizeWallWebhook(kind, payload, receivedAt)`.

- [ ] Write failing tests for check runs, commit statuses, workflow runs, pull requests/reviews, deployments, invalid GitHub URLs, missing SHAs, and timestamp ordering.
- [ ] Run `node --import tsx --test server/wall-normalize.test.ts` and verify missing-module failure.
- [ ] Implement bounded primitives and event-specific normalization. Map CI outcomes to `queued | running | passing | failing | cancelled | neutral`; never retain payload bodies.
- [ ] Run the normalization tests and commit the passing unit.

### Task 2: Durable signal state and signed ingestion

**Files:**

- Create: `server/migrations/009_engineering_wall.sql`
- Create: `server/wall-store.ts`
- Create: `server/wall-store.test.ts`
- Modify: `server/postgres-store.ts`
- Modify: `server/workspace-app.ts`
- Modify: `server/workspace-app.test.ts`

**Interfaces:**

- Consumes: `WallSignalUpdate` from Task 1.
- Produces: `WallStore.apply(installationId, repositoryId, deliveryId, updates)`, `WallStore.snapshot(workspaceId, repositoryIds)`, and PostgreSQL notification scope `wall-workspace-<id>`.

- [ ] Write failing PostgreSQL tests for idempotency, stale-update rejection, repository isolation, bounded snapshots, and deletion/closure state.
- [ ] Add migration 009 with explicit PR, pipeline, deployment, and signal-transition tables plus indexes and constraints.
- [ ] Implement transactional upserts guarded by source timestamps and delivery IDs.
- [ ] Route verified GitHub signal events through `WallStore` after the existing installation/repository checks; keep activity normalization unchanged.
- [ ] Add route tests proving invalid signatures, foreign repositories, duplicate delivery, and unrecognized events cannot write wall state.
- [ ] Run targeted PostgreSQL tests and commit the passing unit.

### Task 3: Authorized wall API and live invalidation

**Files:**

- Modify: `shared/wall.ts`
- Modify: `server/workspace-app.ts`
- Modify: `server/share-app.ts`
- Modify: `server/share-store.ts`
- Modify: `server/workspace-app.test.ts`

**Interfaces:**

- Produces: `GET /api/workspaces/:workspaceId/wall`, `GET /api/workspaces/:workspaceId/wall/stream`, and an allowlisted `wall` field in dashboard share snapshots.

- [ ] Write failing route tests for member access, repository intersection, final-read revocation, shared pinned scope, and secret-field exclusion.
- [ ] Implement private snapshot and SSE invalidation using the same session and installation revalidation pattern as feed/health.
- [ ] Extend dashboard shares with the public wall allowlist and clear live viewers on access loss.
- [ ] Run route/share tests and commit the passing unit.

### Task 4: Pure scene selectors

**Files:**

- Create: `src/lib/engineering-wall.ts`
- Create: `src/lib/engineering-wall.test.ts`

**Interfaces:**

- Produces: `getReviewRadar(snapshot, now)`, `getReleasePulse(snapshot)`, `getWhatChanged(snapshot, events, now)`, `getWallMoments(previous, current)`, `getAttention(snapshot, baseline)`, and `getAvailableScenes(model)`.

- [ ] Write failing tests for prioritization, drafts, unknown mergeability, multi-check aggregation, missing deployment stages, 60-minute/24-hour summaries, first-load silence, recovery, and empty-scene skipping.
- [ ] Implement deterministic selectors with no I/O and stable ordering.
- [ ] Run selector tests and commit the passing unit.

### Task 5: Wall data hook and scene controller

**Files:**

- Create: `src/hooks/useEngineeringWall.ts`
- Create: `src/lib/wall-rotation.ts`
- Create: `src/lib/wall-rotation.test.ts`
- Modify: `src/hooks/useFeed.ts`

**Interfaces:**

- Produces: `EngineeringWallController` and `advanceScene(state, event)` for timer, attention, interaction pause, manual navigation, workspace reset, and hidden-page behavior.

- [ ] Write failing reducer tests for 20-second dwell, empty scenes, attention preemption, recovery return, 60-second interaction pause, reduced motion, and workspace reset.
- [ ] Implement abortable snapshot loading, SSE invalidation coalescing, access-failure clearing, and the pure rotation reducer.
- [ ] Run hook-adjacent and reducer tests and commit the passing unit.

### Task 6: Utilities wall UI

**Files:**

- Create: `src/components/EngineeringWall.tsx`
- Create: `src/components/ReviewRadar.tsx`
- Create: `src/components/ReleasePulse.tsx`
- Create: `src/components/WhatChanged.tsx`
- Create: `src/components/WallAttention.tsx`
- Create: `src/engineering-wall.css`
- Modify: `src/App.tsx`
- Modify: `src/components/SharedDashboard.tsx`

**Interfaces:**

- Consumes: selectors from Task 4 and controller from Task 5.
- Produces: one scene host used by private and shared dashboards.

- [ ] Replace the team dashboard content with a scene host while retaining DashboardPulse, LiveLeaderboard, activity feed, fullscreen, motion, and celebration controls as scenes or overlays.
- [ ] Add compact scene dots, previous/next, pause, countdown, accessible live labels, and no-data fallbacks.
- [ ] Add Review Radar, Release Pulse, What Changed, Health summary, Leaderboard, attention overlay, and moment treatment.
- [ ] Verify keyboard focus, reduced motion, desktop wall, mobile layout, and shared read-only behavior in the browser.
- [ ] Run `npm run build` and commit the passing UI unit.

### Task 7: Permissions, configuration, documentation, and final review

**Files:**

- Modify: `server/github-app.ts`
- Modify: `server/github-app.test.ts`
- Modify: `docs/configuration.md`
- Modify: `docs/architecture.md`
- Modify: `docs/showcase.md`
- Modify: `README.md`

**Interfaces:**

- Consumes: all prior tasks.
- Produces: documented GitHub App read-only permission/event checklist and final release evidence.

- [ ] Update requested permission validation for Checks, Commit statuses, Actions, and Deployments read access; surface a clear reconnect message for installations awaiting approval.
- [ ] Document webhook subscriptions and state limitations, including that absent GitHub signals hide stages.
- [ ] Run all PostgreSQL tests, build, formatting, and diff checks.
- [ ] Browser-test live CI failure, recovery, deployment, attention, rotation, share scope, fullscreen, and mobile with synthetic signed GitHub payloads.
- [ ] Review privacy boundaries, timestamp ordering, idempotency, stale state, first-load effects, and UI overflow; fix findings and repeat affected tests.
- [ ] Commit, push `codex/engineering-wall`, and open a pull request against `main`.
