# ship.live

**Work, in orbit.**

A self-hosted GitHub activity wall for engineering teams. Watch work take shape, explore the story behind every contribution, and celebrate what you ship together.

![ship.live Orbit view with an activity feed, team metrics, repository filters, and replay timeline](docs/images/orbit.jpg)

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="docs/configuration.md">Connect GitHub</a> ·
  <a href="docs/showcase.md">Screenshots</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

## Make the work visible

Code gets shipped across pull requests, reviews, and repositories. ship.live brings those signals into one shared space: an interactive visualization for exploring the work and a live wall for the room where your team builds.

- **Orbit.** One point per event, with repository orbits, drag-to-rotate interaction, and linked event selection.
- **Live activity.** Merges, reviews, releases, pushes, and issues, filtered by repository, type, time, or text.
- **Replay.** Scrub through the last 24 hours, 7 days, or 30 days. The visualization, feed, and view metrics stay in sync.
- **Shared recognition.** Weekly contributor spotlights and team milestones. Reviews and releases count; commit volume earns no XP.
- **Office display.** A fullscreen layout with a visible playback bar and independent controls for motion and live updates.
- **Your infrastructure.** Public activity without GitHub credentials, signed webhooks for live/private events, shared PostgreSQL storage, bundled fonts, and no analytics.

Keyboard navigation, reduced-motion preferences, and small screens are supported. Screenshots use fictional demo data; an empty connected organization stays empty.

## Quick start

Use **Node.js 22.12+**, npm, and Docker Compose for the local PostgreSQL database.

```sh
git clone https://github.com/vndee/ship.live.git
cd ship.live
npm ci
cp .env.example .env
docker compose up -d --wait postgres
npm run dev
```

Open [localhost:5173](http://localhost:5173). The first visit starts in fictional demo mode. Choose **Connect GitHub** to use a public organization. The example database credentials are for local development only; production needs your own PostgreSQL connection in `DATABASE_URL`.

The API requires PostgreSQL and applies its schema migrations on startup. To explore only the frontend demo without a database, run `npm run dev:web`; connecting GitHub requires the API.

| Connection                  | GitHub setup                                        | What you receive                                                   |
| --------------------------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| Demo                        | None                                                | Fictional activity for exploring the interface                     |
| Public organization         | Organization name                                   | Recent public events, subject to GitHub's delay and history limits |
| Live / private organization | Organization webhook, webhook secret, dashboard key | Signed deliveries streamed to connected dashboards                 |

The GitHub public events API can be delayed by **30 seconds to 6 hours** and omits private events. For live activity, configure an organization webhook. A GitHub token raises public API rate limits; it does not make private activity appear in this endpoint. [GitHub documentation](https://docs.github.com/en/rest/activity/events)

See [configuration and self-hosting](docs/configuration.md) for environment variables, webhook setup, storage, and access control.

## A little recognition, shared

| Contribution        |  XP |
| ------------------- | --: |
| Release published   |  50 |
| Pull request merged |  30 |
| Review submitted    |  15 |
| Issue completed     |  10 |
| Pull request opened |   5 |
| Commits pushed      |   0 |

Recognition resets on Monday at 00:00 UTC. Bot accounts and duplicate events do not earn credit. Review credit is capped at one award per reviewer, pull request, and UTC day. Merge credit goes to the pull request author.

Team milestones celebrate 30 merges, 40 reviews, and 5 releases per week. These are conversation starters and shared celebrations, not performance evaluations. View metrics include the events in the current filter; weekly recognition stays independent of replay. Rules live in [`src/lib/activity.ts`](src/lib/activity.ts).

## Run in production

```sh
npm ci
npm run build
npm start
```

The built interface and API are served together at [localhost:3001](http://localhost:3001). Set `DATABASE_URL`, configure GitHub settings from [`.env.example`](.env.example), and use HTTPS. PostgreSQL stores received history and coordinates live events across app replicas. Use a direct database connection or session pooler that supports `LISTEN`; transaction poolers are unsuitable for the dedicated listener.

See [configuration and deployment](docs/configuration.md) for database backups, access control, replica configuration, and importing an existing `events.json` file. The server has no JSON storage fallback.

## Development

```sh
npm run format:check
npm test
# Run all tests, including PostgreSQL integration tests, against a dedicated test database:
TEST_DATABASE_URL=postgres://ship_live:ship_live@127.0.0.1:54329/postgres npm run test:db
npm run build
```

React, TypeScript, and Canvas 2D on the frontend; Express, PostgreSQL, signed webhooks, and server-sent events on the backend. Integration tests create and remove isolated databases using `TEST_DATABASE_URL`; its role needs `CREATE DATABASE` permission. Without that variable, `npm test` skips database tests. CI runs them with PostgreSQL. See the [testing setup](docs/configuration.md#database-tests) for details.

- [Architecture](docs/architecture.md) — data flow, boundaries, and project structure.
- [Contributing](CONTRIBUTING.md) — local setup, checks, and contribution guidelines.
- [Security](SECURITY.md) — deployment assumptions and private vulnerability reports.
- [Changelog](CHANGELOG.md) — changes and upgrade notes.

## Current scope

This is an early, self-hosted project. Each instance supports one webhook organization; instances can share PostgreSQL. Stored events and accepted delivery IDs do not expire automatically, but the API and browser expose only the latest **2,000 events per organization**. There is no historical backfill or multi-user login. Metrics describe the received events available to the browser and may be incomplete. Request limits, upstream caches, and SSE connection limits remain local to each app process.

## License

Licensed under the [MIT License](LICENSE). Copyright © 2026 Duy Huynh.

Bundled dependencies retain their own licenses: [DM Sans](public/licenses/dm-sans.txt), [Lucide and Feather icons](public/licenses/lucide.txt), and [React, React DOM, and Scheduler](public/licenses/react.txt). Their notices are included in production builds under `/licenses/`.
