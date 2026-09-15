# Team follow-through Implementation Plan

> **For agentic workers:** Use test-driven development for each independent deliverable and review the combined integration before completion.

**Goal:** Implement approved proposals 1, 2, 4 and 5 as working features.

**Architecture:** Dedicated feature routers and UI components share existing authorized workspace context. PostgreSQL owns persisted state; URLs own navigation.

**Tech Stack:** TypeScript, React, Express, PostgreSQL, node:test, Playwright.

**Spec:** docs/superpowers/specs/2026-09-15-team-follow-through-design.md

## Global constraints

- Preserve existing source/repository/author authorization and invalidate stale responses.
- One additive migration022; no new dependencies; private state is not exposed by share tokens.
- Keep existing typography, themed controls, keyboard behavior and responsive layout.

## Task 1: Review follow-through

Files: server/review-followthrough*.ts, shared/review-followthrough.ts, src/components/ReviewFollowthrough*, src/components/EngineeringWall.tsx.

- [x] Write atomic-claim, snooze-expiry, obsolete-state and revoked-access regressions; observe failures.
- [x] Implement bounded authorized read and CSRF mutation router/store plus radar controls.
- [x] Run real database and browser tests and report integration prop contract.

## Task 2: Overview comparison

Files: shared/pulse.ts, server/pulse-store.ts, src/components/PulseOverview.tsx, src/components/PulseHistoryFeed.tsx and tests.

- [x] Write literal equal-period, contributor dedup, zero-baseline, partial-history and pagination-type tests; observe failures.
- [x] Implement SQL/demo comparisons and drilldowns.
- [x] Verify shared/personal permissions and browser metric navigation.

## Task 3: Saved views

Files: shared/saved-views.ts, server/saved-views*.ts, src/components/SavedViews.tsx and tests.

- [x] Write route normalization and real owner-isolation API tests; observe failures.
- [x] Implement bounded private persistence with atomic limit and explicit workspace binding.
- [x] Implement create/open/rename/update/delete with dynamic versus fixed period labels and browser tests.

## Task 4: Weekly recap

Files: shared/recap.ts, server/recap*.ts, server/digest.ts, src/pages/RecapPage.tsx and tests.

- [x] Write authorized summary/reflection and scheduling timezone/idempotence tests; observe failures.
- [x] Implement recap and Markdown export; add schedule settings.
- [x] Verify dates, error handling and stale-account responses in the browser.

## Task 5: Integration and verification

Files: server/workspace-app.ts, server/share-app.ts, server/migrations.ts, server/migrations/022_team_followthrough.sql, src/App.tsx, src/components/AppHeader.tsx, src/lib/routes.ts, shared/dashboard-return.ts, README.md, CHANGELOG.md.

- [x] Register routers and single migration; wire routes and sign-in continuation.
- [x] Exercise combined navigation and migration compatibility.
- [x] Run npm run format:check, npm run test:db, npm run test:browser, npm run build and deployment policy gates.
- [x] Review the combined diff, fix findings, document user-visible behavior and provide reviewable changes.

## Completed validation

- Full PostgreSQL suite: 433 passed, zero skipped.
- Browser suite: 96 passed, including actual App navigation and discarded-render regressions.
- Deployment policy: 88 passed; Compose: 3 passed; runtime Docker image: 5 passed.
- Production build, formatting and whitespace checks passed. Existing bundle size advisory remains.
- Independent review fixes cover stale reads/mutations, repository ingestion races and hosted database default grants.
- Desktop 1440px and mobile 390px previews were inspected with synthetic data; no horizontal overflow.
