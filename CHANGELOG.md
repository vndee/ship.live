# Changelog

## Unreleased

- Read four repositories at a time during **Sync**, and report the whole sync in one summary (repositories synced, how many resumed, records found, and any failures) instead of repeating a notice for every batch of 20.
- Draw latency charts at the card's full width and add a **24 hours** view of 15-minute averages between the recent-check and 30-day views.

- Recover the private feed automatically after a transient failure (network, timeout, or server error). Cached private data stays hidden until a verified snapshot arrives, but polling and the live stream keep retrying instead of waiting for a manual retry. A timed-out request now explains itself instead of showing "signal timed out".
- Run **Sync** and the import after connecting an installation in the background. The request returns at once, the outcome is stored per workspace, and the dashboard reports success or failure when the import finishes instead of timing out after three minutes.
- Award 2 XP for each commit a branch push adds to the repository, using GitHub's distinct-commit marker so a commit is credited once. Merges into branches other than the repository default now earn 15 XP; default-branch merges keep 30 XP.
- Authorize reads from each viewer's stored repository access instead of calling GitHub on every request, which exhausted the user's GitHub rate limit. Access refreshes on connect, **Refresh**, and **Sync**; installation repository webhooks narrow it immediately. Rate-limit errors report GitHub's retry time and recognize secondary limits instead of reporting revoked access.
- Request the read-only organization Members permission and consume organization, membership, team, and member webhooks. Access removals take effect immediately and affected viewers are recomputed in the background. Existing installations must approve the new permission.
- Resume **Sync** from each repository's last successful import instead of re-reading the full 30-day window. The Sync control now explains that it spends the user's GitHub API quota while webhooks deliver new activity automatically.
- Add Supabase Google/GitHub login with server-only PKCE handling, HttpOnly cookies, CSRF checks, and shared PostgreSQL session revocation.
- Introduce private personal shipping journals, owner-only manual notes, and GitHub installation workspaces for individuals and teams. Manual notes earn zero XP.
- Connect repository activity through a read-only GitHub App, separate from Supabase's GitHub login OAuth App. Encrypt user/refresh credentials and coordinate token rotation across instances.
- Filter stored events and metrics by each viewer's current GitHub repository IDs; enforce access during reads and live updates, and handle authorization/installation lifecycle changes.
- Import a bounded recent GitHub history with explicit completeness notices, then consume signed live webhooks.
- Enable RLS and revoke browser Data API grants on application tables; document disabling Supabase's unused Data API and the trusted backend database role.
- Replace the mounted organization-name/shared-key API with authenticated workspace routes. Legacy organization records remain stored but are not automatically assigned to new accounts. `GITHUB_ORG`, `GITHUB_TOKEN`, and `DASHBOARD_ACCESS_KEY` no longer configure the default runtime.
- Document Supabase setup, the two distinct GitHub integrations, and Railway free-plan limits and deployment choices. External projects and OAuth registrations are not provisioned by the repository.
- Replace file-backed production storage with shared PostgreSQL. `DATABASE_URL` is now required; `DATA_DIR` is no longer used and there is no JSON fallback.
- Apply versioned SQL migrations automatically at startup, with an optional `npm run db:migrate` command.
- Commit event updates, delivery deduplication, and scope protection together. Retain stored events and accepted delivery IDs without automatic expiry; workspace feeds expose a bounded latest-event view of up to 2,000 events.
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
