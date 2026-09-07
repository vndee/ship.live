# Preparing a release

The project repository is [`vndee/ship.live`](https://github.com/vndee/ship.live). These steps prepare and verify a reviewed release; database deployment remains the responsibility of the host operator.

## Before publishing

- Keep the [MIT License](../LICENSE) and package metadata consistent. Preserve the third-party notices in `public/licenses/`; Vite copies them to production builds.
- Review the staged file list. Keep `.env`, legacy `.data` files, database dumps and backups, dependencies, build outputs, and local artifacts out of Git. Exclude custom paths containing sensitive data too.
- Run `npm ci`, `npm run format:check`, `npm run test:db`, and `npm run build`. Supply `TEST_DATABASE_URL` for a dedicated PostgreSQL test server whose role can create isolated databases; see the [test setup](configuration.md#database-tests). A run with skipped database tests is not sufficient release validation.
- Smoke-test `npm start` with an isolated PostgreSQL database and synthetic GitHub configuration. Confirm `/api/health` and the built interface respond, startup applies migrations, a restart retains received activity, and protected feeds require the expected key.
- For persistence or streaming changes, verify two app instances sharing that database: a webhook accepted by one must reach an authorized viewer on the other, and duplicate deliveries must not create duplicate activity.
- Review the [showcase images](showcase.md), [configuration guide](configuration.md), and upgrade notes in [CHANGELOG.md](../CHANGELOG.md).

## PostgreSQL upgrade and deployment

`DATABASE_URL` is required. Local Compose is a development convenience; the repository does not provision a remote database or choose a hosting provider. Use a direct database endpoint or a session-mode pooler for the dedicated PostgreSQL `LISTEN` connection.

For deployments upgrading from JSON storage:

1. Stop the old writer and back up its `events.json` file.
2. Configure the new PostgreSQL connection and run `npm run db:import-json -- /path/to/events.json`.
3. Preserve the organization's webhook secret, token, and dashboard key on the new instance. Verify the imported feed and protection before directing traffic to it.

The importer leaves the source untouched. It validates the complete file and imports data in one transaction; schema setup runs separately. `DATA_DIR` is no longer read, and there is no JSON fallback. See [the migration guide](configuration.md#importing-an-existing-json-store) for reconciliation and retention details.

For later deployments, take a database backup and review SQL migrations before rollout. Startup applies them automatically under an advisory lock; `npm run db:migrate` can apply them explicitly beforehand. Do not assume an older application version can use a newer schema. Check readiness and database connectivity after rollout, and test restoration as part of the hosting procedure.

Replicas serving the same organization must use the same database and GitHub/dashboard credential configuration. Different organization instances can share the database, while each instance authorizes only its own protected organization. App request limits and upstream caches remain per process.

## Repository details

- **Name:** `ship.live`
- **Description:** Work, in orbit. A self-hosted GitHub activity wall with interactive visualization and shared team milestones.
- **Topics:** `github`, `github-webhooks`, `engineering`, `developer-tools`, `data-visualization`, `self-hosted`, `react`, `typescript`
- **Default branch:** `main`
- **Website:** Leave blank until a public demo or project site exists. The product name does not imply ownership of the matching domain.

## Publish the reviewed release

Push the approved history to the existing repository:

```sh
git push origin main
```

Verify the README images render and the CI workflow passes for that exact commit, including its PostgreSQL integration tests. Check that GitHub private vulnerability reporting remains enabled before relying on the private reporting link in `SECURITY.md`.

Once CI is green, move the relevant changelog entries into a dated release, tag the chosen version, and prepare GitHub release notes from [CHANGELOG.md](../CHANGELOG.md). Call out the PostgreSQL requirement and legacy import procedure for users upgrading from the file-backed version.
