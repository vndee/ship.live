# Changelog

## Unreleased

- Replace file-backed production storage with shared PostgreSQL. `DATABASE_URL` is now required; `DATA_DIR` is no longer used and there is no JSON fallback.
- Apply versioned SQL migrations automatically at startup, with an optional `npm run db:migrate` command.
- Commit event updates, delivery deduplication, and organization protection together. Retain stored events and accepted delivery IDs without automatic expiry; the API and browser still expose only the latest 2,000 events per organization.
- Distribute committed webhook event references across app instances through PostgreSQL `LISTEN`/`NOTIFY`, with listener reconnects and browser polling for recovery.
- Import an existing version-1 `events.json` with `npm run db:import-json -- /path/to/events.json`. Whole-file validation and transactional data import preserve protection and delivery IDs without changing the source file.
- Add PostgreSQL connectivity to health checks and close database connections during graceful shutdown.
- Add a local PostgreSQL 18 Compose service and isolated database integration tests, required by CI.

## 0.1.0 — Initial public version

Initial public version of the project.

- MIT License.
- Interactive Orbit visualization with event selection, repository filters, and time replay.
- GitHub activity feed with public polling and signed webhook ingestion for live/private activity.
- Weekly contributor recognition and shared merge, review, and release milestones.
- Repository overview, event details, and links back to GitHub.
- Fullscreen office display with a viewport-aware timeline and scrollable activity.
- Keyboard controls, reduced-motion support, and responsive layouts.
- Persistent bounded event storage, webhook deduplication, dashboard access keys, and server-sent events.
- Portable production startup, documented configuration, and automated format, test, and build checks.
