# Contributing to ship.live

Focused fixes, accessibility improvements, documentation, and useful ways to explore a builder's work are welcome. For substantial changes, open an issue describing the problem and intended behavior first.

## Local setup

Use Node.js 22.12+ (`nvm use` selects `.nvmrc`), npm, and Docker Compose:

```sh
npm ci
cp .env.example .env
docker compose up -d --wait postgres
npm run dev
```

Open `http://127.0.0.1:5173`, consistently matching `APP_URL`. Vite proxies `/api` to port 3001. The API applies PostgreSQL migrations at startup. Local database credentials are development defaults; never reuse them for hosting. The fictional demo needs no provider configuration. `npm run dev:web` supports frontend-only demo work without PostgreSQL.

Real journals need a configured Supabase project with Google/GitHub login. Repository integration needs a separate GitHub App and a public webhook URL. [Configuration](docs/configuration.md) distinguishes the two OAuth integrations. Do not connect a contributor's development environment to production user data.

## Before a pull request

```sh
npm run format:check
TEST_DATABASE_URL=postgres://ship_live:ship_live@127.0.0.1:54329/postgres npm run test:db
npm run build
```

Use a dedicated test connection with `CREATE DATABASE` permission. The helper creates isolated databases and removes only those afterward. Tests do not load `.env` or use `DATABASE_URL`. `npm test` skips PostgreSQL tests without `TEST_DATABASE_URL`; run the full suite for backend changes. CI always runs it.

OAuth tests exercise real Express/PostgreSQL with mocked provider responses. They do not prove your external Google, GitHub, or Supabase registration works. Any real consent/installation testing must use a controlled test account and repositories.

Use `npm run format` for formatting. Add meaningful tests for behavioral changes and regressions, especially ownership, repository filtering, callback replay, CSRF, session revocation, and failure paths. Keep SQL migrations compatible with existing data and never expose legacy private records through an implicit ownership claim.

For visible changes, test desktop/mobile, fullscreen where relevant, keyboard navigation, reduced motion, and demo-versus-real workspace separation. Include screenshots using fictional data. Describe the problem, resulting behavior, and validation in the PR; keep unrelated refactoring separate.

## Project conventions

- Keep provider credentials, session cookies, encryption keys, database URLs/dumps, and private activity out of source control. `.env` and legacy `.data/` are ignored, but custom paths need their own exclusions.
- Use synthetic identities and repositories in fixtures. Never fetch or record a user's private data just to create a showcase image.
- Application data goes through the authenticated Express API. Do not add a browser Supabase Data API shortcut around workspace/repository authorization.
- `shared/types.ts`, `shared/auth.ts`, and `shared/workspaces.ts` define client/server contracts. New event types need normalization, recognition semantics, UI labels, and relevant tests.
- Credit outcomes and collaboration. Raw commit volume and manual notes should not increase XP.
- Prefer the existing toolchain and small dependencies with a clear purpose.

See [architecture](docs/architecture.md) for the boundaries between identity, repository access, storage, and visualization.

## Reporting issues

Include reproduction steps, expected/actual behavior, browser/OS, and whether the issue occurs in demo, a personal journal, or a team workspace. Remove private details from screenshots and logs. For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue. Keep discussion specific and respectful.
