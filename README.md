# ship.live

**Great work. Shared momentum.**

A private shipping journal for individual builders and a live GitHub activity wall for engineering teams. Connect the repositories you choose, capture the story behind your work, and see what you have shipped.

![ship.live live team XP leaderboard and activity feed](docs/images/leaderboard.jpg)

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="docs/configuration.md">Connect accounts</a> ·
  <a href="docs/railway.md">Deploy on Railway</a> ·
  <a href="docs/showcase.md">Screenshots</a> ·
  <a href="PRIVACY.md">Hosted service privacy</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

## For your work, and your team's

- **Personal journal.** Keep private notes about launches, experiments, decisions, and progress. Add GitHub activity from selected repositories when you are ready.
- **Google or GitHub sign-in.** Supabase Auth handles identity. A separate GitHub App connection grants repository access, including for someone who signed in with Google.
- **Live team leaderboard.** Follow weekly XP, animated rank changes, contribution bars, and live XP gains beside the activity feed.
- **Team momentum.** See today’s contributions, a seven-day activity chart, and the nearest weekly milestone at a glance.
- **Engineering utilities wall.** Rotate through Team Pulse, Review Radar, GitHub deployment status, Service Health, and the XP leaderboard. Current failures interrupt the rotation and recoveries produce a brief team moment.
- **Live celebrations.** New contributions briefly highlight in the feed and announce earned XP. Merges and releases launch confetti, with a bigger burst for milestones. Motion and celebration controls keep the dashboard comfortable; try a fictional event with **Try live activity** in demo mode.
- **Live activity and replay.** Follow merges, reviews, releases, pushes, issues, and journal entries. Filter by repository, type, time, or text; replay the last 24 hours, 7 days, or 30 days.
- **Shared recognition.** Weekly contributor spotlights and team milestones celebrate outcomes and collaboration. Raw commit counts and personal notes earn no XP.
- **Expiring dashboard links.** Share a read-only team dashboard without requiring sign-in. Choose from one hour through a 100-year no-expiration option; rotate or revoke your link at any time.
- **Private by default.** Personal notes belong to their owner. GitHub events are filtered to repositories each viewer can currently access through the GitHub App.
- **Self-hosted.** React, Express, and shared PostgreSQL, with bundled fonts and no analytics. One Node.js service serves the frontend and API.

Keyboard navigation, reduced-motion preferences, small screens, and fullscreen displays are supported. Screenshots use fictional demo data. Demo activity is never copied into a real workspace.

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

| Contribution           |  XP |
| ---------------------- | --: |
| Release published      |  50 |
| Pull request merged    |  30 |
| Review submitted       |  15 |
| Issue completed        |  10 |
| Pull request opened    |   5 |
| Commits pushed         |   0 |
| Personal journal entry |   0 |

Recognition resets on Monday at 00:00 UTC. Bots and duplicate events do not earn credit. Review credit is capped at one award per reviewer, pull request, and UTC day; merge credit belongs to the pull request author. Team milestones celebrate 30 merges, 40 reviews, and 5 releases per week.

These are shared celebrations, not performance evaluations. Metrics describe the events visible to the current viewer, so teammates with different repository permissions can see different totals. Replay changes the view, not the recognition rules. See [`src/lib/activity.ts`](src/lib/activity.ts).

## Deploy

```sh
npm ci
npm run build
npm start
```

Production serves the built UI and API together on `PORT` (default `3001`). Set your public HTTPS origin as `APP_URL`, configure authentication, and point `DATABASE_URL` at persistent PostgreSQL. Startup applies SQL migrations; there is no JSON or memory fallback.

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
- [Contributing](CONTRIBUTING.md) — development conventions and checks.
- [Security](SECURITY.md) — protection boundaries and private vulnerability reporting.
- [Changelog](CHANGELOG.md) — changes and upgrade notes.

## Current scope

Personal journals remain private. Team members can explicitly share a read-only dashboard through an expiring link. Each member manages one link per workspace; rotating it immediately invalidates their previous link. Sharing pins the creator’s current repository IDs and rechecks their live GitHub permissions on reads. Notes are never shared. Newly accessible repositories require a new link. Public profiles and journal publishing are not implemented.

GitHub connection imports a bounded recent activity history, not a complete archive. Subsequent signed webhooks supply live activity plus current pull-request, check, workflow, commit-status, and deployment signals; push history begins with those webhooks. CI/CD providers appear through the states they publish back to GitHub, so ship.live requires no provider-specific integration. The UI displays at most 2,000 activity events per workspace and bounds each wall signal category in snapshots. Stored events and accepted delivery IDs do not expire automatically, so operators must plan retention and backups. Request counters and live-connection limits remain per process.

The old organization-name/shared-key routes are not mounted by the current server. Legacy events remain in their original database namespaces and are not automatically assigned to a newly signed-in user. See [upgrade notes](docs/configuration.md#upgrading-an-existing-installation).

## License

Licensed under the [MIT License](LICENSE). Copyright © 2026 Duy Huynh.

Bundled dependencies retain their own licenses: [DM Sans](public/licenses/dm-sans.txt), [Lucide and Feather icons](public/licenses/lucide.txt), and [React, React DOM, and Scheduler](public/licenses/react.txt). Their notices are included in production builds under `/licenses/`.
