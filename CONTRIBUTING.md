# Contributing to ship.live

Small, focused contributions are welcome: bug fixes, accessibility improvements, better documentation, and clearer ways to explore engineering activity. For a substantial change, open an issue describing the problem and proposed behavior first.

## Local setup

Fork the repository, clone your fork, and use Node.js 22.12+ (`nvm use` selects the version in `.nvmrc`). Docker Compose supplies the local PostgreSQL database.

```sh
npm ci
cp .env.example .env
docker compose up -d --wait postgres
npm run dev
```

The frontend runs at `http://localhost:5173` and proxies `/api` to port 3001. The API requires `DATABASE_URL` and applies SQL migrations on startup. The example URL matches the local Compose service; its credentials are for development only. Demo mode needs no GitHub credentials. For frontend-only work without an API or database, use `npm run dev:web`.

See [configuration.md](docs/configuration.md) for an existing PostgreSQL server, GitHub setup, and deployment settings.

## Before a pull request

```sh
npm run format:check
TEST_DATABASE_URL=postgres://ship_live:ship_live@127.0.0.1:54329/postgres npm run test:db
npm run build
```

The database test helper creates isolated databases and drops only those databases afterward. Use a dedicated test connection with `CREATE DATABASE` permission. Test commands do not load `.env` or use `DATABASE_URL`; provide `TEST_DATABASE_URL` explicitly. `npm test` can run without PostgreSQL, but skips database integration tests when that variable is absent. Run the full database suite for backend changes; CI always does.

Use `npm run format` to apply formatting. Add meaningful tests when behavior changes; cover the original failure for bug fixes. Check affected interactions at desktop and mobile widths, and fullscreen when changing layout. Preserve keyboard navigation, focus handling, reduced motion, and the distinction between demo and connected data.

Describe the problem, resulting behavior, and validation in your pull request. Include before/after screenshots for visible changes, using demo data. Keep unrelated refactoring separate so the change is easy to review.

## Project conventions

- Keep organization configuration in environment variables. Never commit `.env`, database credentials or dumps, tokens, webhook secrets, private activity, or legacy store files.
- Use fictional actors and generic organization names in fixtures and screenshots.
- `shared/types.ts` defines the normalized event contract. New event types need normalization, recognition semantics, UI labels, and relevant tests.
- Credit useful outcomes and collaboration. Raw commit volume should not increase scores.
- Prefer the existing toolchain and small dependencies with a clear purpose.

See [architecture.md](docs/architecture.md) for how the frontend and server fit together.

## Reporting issues

Include steps to reproduce, expected and actual behavior, browser/OS, and whether the issue occurs in demo or connected mode. Remove repository names or other private details before attaching screenshots and logs.

For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue. Keep discussion specific and respectful; critique the work and give contributors room to explain their reasoning.
