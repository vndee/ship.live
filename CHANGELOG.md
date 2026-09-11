# Changelog

## Unreleased

- Add team webhooks. Outbound webhooks send activity, CI and deployment changes, Service Health incidents and probe changes, inbound alerts, and a weekly digest to Slack, Discord, Microsoft Teams, Google Chat, Lark / Feishu, or any HTTPS endpoint. Bodies are Handlebars-like templates with a live preview. Webhooks filter by repository, branch, environment, service, person, or summary text, with wildcards and exclusions, and a cooldown holds repeated alerts until a recovery. Requests are signed (an `X-Ship-Signature` header, or Lark's body fields), can require a JSON value in the response, retry with backoff for about nine hours, and are logged for 30 days with test sends and redelivery. URLs, header values, and secrets are encrypted, and deliveries follow the webhook owner's current repository access, checked again before every attempt. A rerun or the next commit's run of the same check on the same branch counts as one pipeline, so CI recoveries are announced. See the [webhook guide](docs/webhooks.md).
- Add inbound webhooks: a secret URL, optionally HMAC-signed, whose JSON is mapped by templates to a title, details, link, and delivery ID, then passed on to outbound webhooks.
- Record Service Health incidents. Each period a probe is down opens and resolves an incident, shown on its service for 30 days and kept for a year.
- Upgrade note: migration 015 adds the webhook, inbound, incident, and digest tables. Webhooks need `TOKEN_ENCRYPTION_KEY`.

- Give every page its own URL: `/` for Pulse, `/health`, `/feed`, `/team`, and `/milestones`. The Live feed keeps its repository, activity type, search, and period in the URL, and `?person=<login>` opens a contributor profile, so any view can be bookmarked, opened in a new tab, or sent to a teammate with access. Back closes a profile and returns to the previous page. The main navigation and back links are real links.
- Share request limits across replicas. Each client's per-minute count lives in PostgreSQL, and responses carry `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset`. If the database is unreachable, each process falls back to its own counts.
- Add a retention job. Accepted webhook delivery IDs expire after 30 days (`DELIVERY_RETENTION_DAYS`); GitHub activity and wall signals expire only once `EVENT_RETENTION_DAYS` is set, to 31 days or more. Open pull requests and journal notes are never removed. It runs hourly on one replica at a time, in batches.
- Write structured logs, JSON lines in production (`LOG_FORMAT`, `LOG_LEVEL`), with an `X-Request-Id` on every response and a log line for each failed request. Set `METRICS_TOKEN` to serve Prometheus metrics at `/metrics`.
- Send the production security headers with API responses too, and add `Permissions-Policy`, `Cross-Origin-Opener-Policy`, and `manifest-src`.
- Make ship.live installable as a web app, with a manifest, 192 and 512 px icons, and shortcuts to Service Health and the Live feed. No service worker caches private data.
- Run the browser tests in CI, and split `App.tsx` into page components.
- Upgrade note: migration 014 adds the request-limit table and age indexes on events, deliveries, and wall signals. On a large event table, building the index delays startup and briefly blocks webhook writes.

- Show the Orbit Pulse mark beside the ship.live wordmark in the app and on shared pages, with ".live" muted as in the brand wordmark. Light mode uses the app icon, since the mark's paths are never recolored.

- Show each service's 24-hour uptime and latency (mean ± standard deviation) in its row, with an info tooltip explaining both; Pulse's Service health cards use the same figures. The signed-out home page gains a read-only Service Health demo, the demo workspace is called Acme Team, and the Service Health footnote is gone.

- Simplify the navigation to **Pulse** (formerly Dashboard) and **Service Health**. The Live feed opens from the activity list, milestones from the milestone card, and the contributor table from the leaderboard's **All contributors**; each leads back to Pulse. Repositories become a section of the Overview scene (formerly Team pulse), most active this week first, and choosing one opens its activity in the Live feed. Personal journals list their sources under the leaderboard.

- Keep the team dashboard on the scene you choose. Scenes are labeled tabs instead of dots, and an **Auto-slide** toggle moves between them. Auto-slide is off by default, on for signed-out visitors and the fullscreen wall display, and pauses while the pointer is over the wall. Only auto-slide jumps to a scene that needs attention, and an attention banner can be dismissed until a different incident appears. **Arrange tabs** hides and reorders scenes; the order and visibility are remembered in the browser for each workspace.
- Open a contributor's profile from the leaderboard or the Team page: weekly rank and XP, 30-day XP, contributions and active days, a 12-week activity heatmap, daily XP for 30 days, a breakdown by activity type, and recent activity. Both charts can be explored by pointer or keyboard and have a table view.
- Always offer Review Radar and Service Health tabs, with empty states, and redesign their rows and cards: state chips, status pills, and service cards with recent status, latency, and 24-hour success. The demo shows fictional pull requests, deployments, and services.
- Make text easier to read: labels and metadata are at least 12px on desktop, DM Sans renders with a taller lowercase and a slightly heavier default weight (light mode also drops grayscale antialiasing, which thinned dark text), body text has more line spacing, and secondary text meets 4.5:1 contrast in both themes. The signed-out home page no longer shows "Demo" status labels.
- Show only actionable workspace notices under the page heading. The description of what the feed covers moves to the Repositories page.

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
