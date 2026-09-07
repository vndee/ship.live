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
- **Your infrastructure.** Public activity without credentials, signed webhooks for live/private events, bundled fonts, and no analytics.

Keyboard navigation, reduced-motion preferences, and small screens are supported. Screenshots use fictional demo data; an empty connected organization stays empty.

## Quick start

Use **Node.js 22.12+** and npm.

```sh
git clone https://github.com/vndee/ship.live.git
cd ship.live
npm ci
npm run dev
```

Open [localhost:5173](http://localhost:5173). Demo mode works immediately, with no account or environment file required. Choose **Connect GitHub** to use a public organization.

| Connection                  | Setup                                               | What you receive                                                   |
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

The built interface and API are served together at [localhost:3001](http://localhost:3001). Configure `.env` from [`.env.example`](.env.example), use HTTPS, and keep the data directory on persistent storage. The server runs as a single Node process; see the [deployment notes](docs/configuration.md) before hosting private activity.

## Development

```sh
npm run format:check
npm test
npm run build
```

React, TypeScript, and Canvas 2D on the frontend; Express, signed webhooks, server-sent events, and a bounded JSON store on the backend. No database service is required.

- [Architecture](docs/architecture.md) — data flow, boundaries, and project structure.
- [Contributing](CONTRIBUTING.md) — local setup, checks, and contribution guidelines.
- [Security](SECURITY.md) — deployment assumptions and private vulnerability reports.
- [Changelog](CHANGELOG.md) — changes in the initial release.

## Current scope

This is an early, self-hosted project. Each instance supports one webhook organization. The store retains up to 2,000 events; it is not a full activity archive. There is no historical backfill, multi-user login, or multi-replica storage. Metrics describe received activity and may be incomplete.

## License

A license is being selected for the initial public release. Until `LICENSE` is added, no open-source license is granted.
