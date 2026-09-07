# ship.live

**Work, in orbit.**

A private shipping journal for individual builders and a live GitHub activity wall for engineering teams. Connect the repositories you choose, capture the story behind your work, and see what you have shipped.

![ship.live Orbit view with an activity feed, team metrics, repository filters, and replay timeline](docs/images/orbit.jpg)

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="docs/configuration.md">Connect accounts</a> ·
  <a href="docs/railway.md">Deploy on Railway</a> ·
  <a href="docs/showcase.md">Screenshots</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

## For your work, and your team's

- **Personal journal.** Keep private notes about launches, experiments, decisions, and progress. Add GitHub activity from selected repositories when you are ready.
- **Google or GitHub sign-in.** Supabase Auth handles identity. A separate GitHub App connection grants repository access, including for someone who signed in with Google.
- **Orbit.** Explore one point per event, repository orbits, linked event selection, and a camera you can rotate.
- **Live activity and replay.** Follow merges, reviews, releases, pushes, issues, and journal entries. Filter by repository, type, time, or text; replay the last 24 hours, 7 days, or 30 days.
- **Shared recognition.** Weekly contributor spotlights and team milestones celebrate outcomes and collaboration. Raw commit counts and personal notes earn no XP.
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

Personal journals and team workspaces are private. Public profiles, public journal publishing, and invitation-based sharing outside GitHub repository permissions are not implemented.

GitHub connection imports a bounded recent history, not a complete activity archive. Subsequent signed webhooks supply live events; push history begins with those webhooks. The UI displays at most 2,000 events per workspace. Stored events and accepted delivery IDs do not expire automatically, so operators must plan retention and backups. Request counters and live-connection limits remain per process.

The old organization-name/shared-key routes are not mounted by the current server. Legacy events remain in their original database namespaces and are not automatically assigned to a newly signed-in user. See [upgrade notes](docs/configuration.md#upgrading-an-existing-installation).

## License

Licensed under the [MIT License](LICENSE). Copyright © 2026 Duy Huynh.

Bundled dependencies retain their own licenses: [DM Sans](public/licenses/dm-sans.txt), [Lucide and Feather icons](public/licenses/lucide.txt), and [React, React DOM, and Scheduler](public/licenses/react.txt). Their notices are included in production builds under `/licenses/`.
