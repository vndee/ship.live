# ship.live

<p align="center">
  <img src="public/branding/orbit-pulse-cover.png" alt="ship.live — Great work. Shared momentum." width="800">
</p>

A private shipping journal for individual builders and a live **Pulse** for engineering teams. Connect the repositories you choose, capture the story behind your work, watch what the team ships as it happens, and keep an eye on the services you run.

![Pulse Overview with today's momentum, the seven-day chart, the next team milestone, the most active repositories, and live activity](docs/images/pulse-overview.jpg)

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="docs/configuration.md">Connect accounts</a> ·
  <a href="docs/self-host-docker.md">Self-host with Docker</a> ·
  <a href="docs/railway.md">Deploy on Railway</a> ·
  <a href="docs/showcase.md">Screenshots</a> ·
  <a href="PRIVACY.md">Hosted service privacy</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

## Pulse

The team's live view of what is shipping, beside a feed of every visible contribution.

- **Overview.** Today’s momentum, a seven-day activity chart, the next team milestone, and the repositories that moved most this week. Choose a repository to open its details: this week, a 12-week heatmap, top contributors, recent activity, open pull requests, and deployments.
- **Review Radar and Release Pulse.** Open pull requests ranked by what needs attention — failing CI, ready to merge, checks running, awaiting review — and the latest GitHub deployment for each environment.
- **Delivery.** Deployments per week, change failure rate, time to restore, and time to merge for one environment over 30 days, each compared with the 30 days before, with eight weeks of deployments by week. The figures describe the team, never a person.
- **Leaderboard and profiles.** Weekly XP with animated rank changes. Open anyone’s profile for their rank, 30-day totals, a 12-week activity heatmap, daily XP, and recent activity.
- **Your own heading.** Rename the Pulse title and add a subtitle for your team; it shows on the wall display and on shared links too.
- **Arranged your way.** Tabs stay where you put them. Turn on **Auto-slide** for a wall display, and hide or reorder tabs for each workspace. Failures raise an attention banner you can dismiss, and recoveries produce a brief team moment.
- **Live celebrations.** New contributions highlight in the feed and announce earned XP; merges and releases launch confetti, with a bigger burst for milestones. Try a fictional event with **Try live activity** in the demo.

## Service Health

Checks for the public HTTP APIs your team depends on, run from the server even when nobody has the page open.

- **Precise probes.** Accepted status ranges, latency limits, and exact JSON conditions, with encrypted secret headers.
- **Uptime and latency at a glance.** Each service shows its 24-hour uptime and latency mean ± standard deviation, with recent, 24-hour, and 30-day latency charts for every probe.
- **90-day uptime and maintenance.** A status-page strip of daily uptime for each service, on the dashboard and the share page. Schedule maintenance for one service or the whole workspace; failing checks inside a window change no status, open no incident, and are left out of uptime.
- **Shareable status.** Arrange services for the team and share a read-only status page through an expiring link.
- **Incident history.** Each time a probe goes down, an incident opens and later resolves. Services list open incidents and those from the last 30 days, and webhooks announce them.

## Webhooks

Send what matters to the tools your team already watches, and bring outside alerts in.

- **Every event, any destination.** Merges, reviews, releases, CI failures and recoveries, deployments, Service Health incidents, inbound alerts, and a weekly digest, sent to Slack, Discord, Microsoft Teams, Google Chat, Lark / Feishu, or any HTTPS endpoint.
- **Bodies you control.** A preset for each service and a template editor with a live preview, filters with wildcards and exclusions, cooldowns for flapping alerts, custom headers, signed requests, and success checks for services that report errors inside a 200 response.
- **Reliable delivery.** Retries with backoff, a delivery log with each request and response, test sends, and redelivery. Deliveries follow each webhook owner's repository access, checked again before every attempt.
- **Inbound alerts.** Give Grafana, Sentry, or any service a URL, map its JSON to a title and link, see it in Live activity, and pass it on.

See the [webhook guide](docs/webhooks.md).

## Also included

- **Personal journal.** Keep private notes about launches, experiments, decisions, and progress. Add GitHub activity from selected repositories when you are ready. Group notes with #tags, filter the feed by tag, and export any view as Markdown.
- **Google or GitHub sign-in.** Supabase Auth handles identity. A separate GitHub App connection grants repository access, including for someone who signed in with Google.
- **Live activity and replay.** Follow merges, reviews, releases, pushes, issues, journal entries, and inbound alerts. Filter by repository, type, time, or text; replay the last 24 hours, 7 days, or 30 days.
- **Shared recognition.** Weekly contributor spotlights and team milestones celebrate outcomes and collaboration. New commits earn a small per-commit credit; personal notes earn no XP.
- **Expiring share links.** Share a read-only Pulse or Service Health page without requiring sign-in. Choose from one hour through a 100-year no-expiration option; rotate or revoke your link at any time.
- **Private by default.** Personal notes belong to their owner. GitHub events are filtered to repositories each viewer could access through the GitHub App at their last sync.
- **A link for every view.** Pulse, Service Health, the Live feed with its filters, and contributor profiles each have a URL to bookmark or share with teammates who have access. Install ship.live from the browser for its own window.
- **Self-hosted.** React, Express, and shared PostgreSQL, with bundled fonts and no analytics. One Node.js service serves the frontend and API, writes structured logs, and can expose Prometheus metrics.

Keyboard navigation, reduced-motion preferences, small screens, and fullscreen displays are supported. Screenshots use fictional demo data from the signed-out demo, which also includes a read-only Service Health page. Demo activity is never copied into a real workspace.

## Quick start

Use **Node.js 22.12+**, npm, and Docker Compose for local PostgreSQL.

```sh
git clone https://github.com/vndee/ship.live.git
cd ship.live
npm ci
cp .env.example .env
docker compose up -d --wait postgres
npm run dev
```

Open [127.0.0.1:5173](http://127.0.0.1:5173). You can explore the fictional demo before configuring authentication. The database credentials in `.env.example` are for this local Compose service only.

To use real workspaces:

1. Create a Supabase project and enable its Google and GitHub providers. Set `APP_URL`, `SUPABASE_URL`, and `SUPABASE_PUBLISHABLE_KEY` on the server.
2. Sign in to get a private personal journal. Google-only users can write notes without connecting GitHub.
3. Register and configure a GitHub App, then connect it from ship.live and install it on a personal account or organization. Choose the repositories it may access.

The full [configuration guide](docs/configuration.md) distinguishes the Supabase sign-in callback from the GitHub App connection callback. Creating OAuth clients, provider secrets, a GitHub App, and a public webhook URL is part of self-hosting; this repository does not provision those external accounts.

For frontend-only demo work without a database, use `npm run dev:web`.

## Recognition

| Contribution                            |           XP |
| --------------------------------------- | -----------: |
| Release published                       |           50 |
| Pull request merged into default branch |           30 |
| Pull request merged into another branch |           15 |
| Review submitted                        |           15 |
| Issue completed                         |           10 |
| Pull request opened                     |            5 |
| Commit pushed                           | 2 per commit |
| Personal journal entry                  |            0 |

Recognition resets on Monday at 00:00 UTC. Bots and duplicate events do not earn credit. Review credit is capped at one award per reviewer, pull request, and UTC day; merge credit belongs to the pull request author. Commit credit belongs to the pusher and counts only commits new to the repository, so creating a branch or merging with a merge commit does not credit the same commits again. Merges whose target branch GitHub did not report keep default-branch credit. Team milestones celebrate 30 merges, 40 reviews, and 5 releases per week.

These are shared celebrations, not performance evaluations. Metrics describe the events visible to the current viewer, so teammates with different repository permissions can see different totals. Replay changes the view, not the recognition rules. See [`src/lib/activity.ts`](src/lib/activity.ts).

## Deploy

```sh
npm ci
npm run build
npm start
```

Production serves the built UI and API together on `PORT` (default `3001`). Set your public HTTPS origin as `APP_URL`, configure authentication, and point `DATABASE_URL` at persistent PostgreSQL. Startup applies SQL migrations; there is no JSON or memory fallback. Logs are JSON lines; set `METRICS_TOKEN` to serve Prometheus metrics at `/metrics`, and `EVENT_RETENTION_DAYS` to expire old activity. See [configuration](docs/configuration.md#logs-metrics-and-retention).

For a physical Linux machine, the [Docker self-host guide](docs/self-host-docker.md) provides a production image and Compose stack with PostgreSQL, automatic Caddy HTTPS, persistent volumes, healthchecks, backup, restore, and upgrade commands.

**Supabase Auth + Supabase PostgreSQL + one Railway Node service** is a practical starting point. The database needs a direct connection or session pooler that supports `LISTEN`. Free plans can support a prototype, but Railway's monthly credit does not guarantee an always-on service at no cost. The [Railway guide](docs/railway.md) includes current quotas, estimates, connection settings, and availability tradeoffs.

## Development

```sh
npm run format:check
npm test
TEST_DATABASE_URL=postgres://ship_live:ship_live@127.0.0.1:54329/postgres npm run test:db
npm run build
```

The database suite creates and removes isolated test databases. Use a dedicated test connection with `CREATE DATABASE` permission. `npm test` skips PostgreSQL tests when `TEST_DATABASE_URL` is absent; CI runs the full suite. OAuth tests exercise Express and PostgreSQL with mocked external provider responses. Testing real consent screens requires your own configured providers.

- [Architecture](docs/architecture.md) — identity, repository permissions, storage, and realtime.
- [Configuration](docs/configuration.md) — OAuth setup, GitHub App setup, migration, and hosting.
- [Webhooks](docs/webhooks.md) — events, presets, templates, signing, delivery, and inbound alerts.
- [Service Health](docs/service-health.md) — probes, JSON conditions, figures, and sharing.
- [Branding](public/branding/README.md) — the Orbit Pulse mark, palette, and usage.
- [Contributing](CONTRIBUTING.md) — development conventions and checks.
- [Security](SECURITY.md) — protection boundaries and private vulnerability reporting.
- [Changelog](CHANGELOG.md) — changes and upgrade notes.

## Current scope

Personal journals remain private. Team members can explicitly share a read-only Pulse or Service Health page through an expiring link. Each member manages one link of each kind per workspace; rotating it immediately invalidates their previous link. Sharing pins the creator’s current repository IDs and rechecks their live GitHub permissions on reads. Notes are never shared. Newly accessible repositories require a new link. Public profiles and journal publishing are not implemented.

GitHub connection imports a bounded recent activity history, not a complete archive. Subsequent signed webhooks supply live activity plus current pull-request, check, workflow, commit-status, and deployment signals; push history begins with those webhooks. CI/CD providers appear through the states they publish back to GitHub, so ship.live requires no provider-specific integration. The UI displays at most 2,000 activity events per workspace and bounds each wall signal category in snapshots. Accepted webhook delivery IDs expire after 30 days by default (`DELIVERY_RETENTION_DAYS`); activity is kept until an operator sets `EVENT_RETENTION_DAYS`, so plan retention and backups. Request limits are shared across replicas through PostgreSQL; live-connection limits remain per process.

The old organization-name/shared-key routes are not mounted by the current server. Legacy events remain in their original database namespaces and are not automatically assigned to a newly signed-in user. See [upgrade notes](docs/configuration.md#upgrading-an-existing-installation).

## License

Licensed under the [MIT License](LICENSE). Copyright © 2026 Duy Huynh.

Bundled dependencies retain their own licenses: [DM Sans](public/licenses/dm-sans.txt), [Lucide and Feather icons](public/licenses/lucide.txt), and [React, React DOM, and Scheduler](public/licenses/react.txt). Their notices are included in production builds under `/licenses/`.
