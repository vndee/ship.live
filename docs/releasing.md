# Preparing a release

The project repository is [`vndee/ship.live`](https://github.com/vndee/ship.live). These steps prepare and verify a reviewed release; database deployment remains the responsibility of the host operator.

## Before publishing

- Keep the [MIT License](../LICENSE) and package metadata consistent. Preserve the third-party notices in `public/licenses/`; Vite copies them to production builds.
- Review the staged file list. Keep `.env`, legacy `.data` files, database dumps and backups, dependencies, build outputs, and local artifacts out of Git. Exclude custom paths containing sensitive data too.
- Run `npm ci`, `npm run format:check`, `npm run test:db`, and `npm run build`. Supply `TEST_DATABASE_URL` for a dedicated PostgreSQL test server whose role can create isolated databases; see the [test setup](configuration.md#database-tests). A run with skipped database tests is not sufficient release validation.
- Smoke-test `npm start` with an isolated PostgreSQL database. Confirm `/api/health` and the built interface respond, startup applies migrations, private routes require an authenticated session, and the former organization/key API routes return `404`. Use synthetic provider fixtures for automated tests; also verify real Google/GitHub sign-in and GitHub App consent in a separately configured staging environment before a production rollout.
- For persistence or streaming changes, verify two app instances sharing that database: a webhook accepted by one must reach an authorized viewer on the other, and duplicate deliveries must not create duplicate activity.
- Review the [showcase images](showcase.md), [configuration guide](configuration.md), and upgrade notes in [CHANGELOG.md](../CHANGELOG.md).

## PostgreSQL upgrade and deployment

`DATABASE_URL` is required. Local Compose is a development convenience; the repository does not provision a remote database or choose a hosting provider. Use a direct database endpoint or a session-mode pooler for the dedicated PostgreSQL `LISTEN` connection.

For deployments upgrading from JSON storage:

1. Stop the old writer and back up its `events.json` file.
2. Configure the new PostgreSQL connection and run `npm run db:import-json -- /path/to/events.json`.
3. Retain the imported data for recovery. Legacy organization records are not automatically assigned to a new account or installation, and the old token/dashboard-key routes are no longer mounted. Configure Supabase Auth and the GitHub App, sign in, connect selected repositories, and verify the new private workspace before directing traffic to it.

The importer leaves the source untouched. It validates the complete file and imports data in one transaction; schema setup runs separately. `DATA_DIR` is no longer read, and there is no JSON fallback. See [the upgrade guide](configuration.md#upgrading-an-existing-installation) for access and migration details.

For later deployments, take a database backup and review SQL migrations before rollout. Startup applies them automatically under an advisory lock; `npm run db:migrate` can apply them explicitly beforehand. Do not assume an older application version can use a newer schema. Check readiness and database connectivity after rollout, and test restoration as part of the hosting procedure.

Replicas must use the same database, Supabase project, GitHub App credentials, `APP_URL`, and `TOKEN_ENCRYPTION_KEY`. Changing the encryption key requires a deliberate migration or reconnect procedure; do not replace it casually. Repository access is checked per signed-in viewer. Verify that disconnect, logout, and permission revocation remove private data across instances. Request limits are shared through PostgreSQL; if it is unreachable, each process falls back to its own counts, so replicas together can briefly allow more than the limit. Live-stream limits remain per process.

For Supabase-hosted PostgreSQL, verify application tables have RLS enabled and no grants to `PUBLIC`, `anon`, or `authenticated`; disable the unused Data API. Use a direct connection or the session pooler, not transaction pooling. See [Railway deployment](railway.md) for hosting settings and free-plan limits.

## Repository details

- **Name:** `ship.live`
- **Description:** Work, in orbit. Private ship journals and GitHub activity for individual builders and teams.
- **Topics:** `github`, `github-webhooks`, `engineering`, `developer-tools`, `data-visualization`, `self-hosted`, `react`, `typescript`
- **Default branch:** `main`
- **Website:** Leave blank until a public demo or project site exists. The product name does not imply ownership of the matching domain.

## Publish the reviewed release

Push the approved history to the existing repository:

```sh
git push origin main
```

Verify the README images render and the CI workflow passes for that exact commit, including its PostgreSQL integration tests. Check that GitHub private vulnerability reporting remains enabled before relying on the private reporting link in `SECURITY.md`.

Once CI is green, move the relevant changelog entries into a dated release, tag the chosen version, and prepare GitHub release notes from [CHANGELOG.md](../CHANGELOG.md). Call out the required Supabase/GitHub App setup and the removal of legacy organization/key access for existing installations.
