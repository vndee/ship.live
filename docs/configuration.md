# Configuration and hosting

ship.live can browse public GitHub organization activity without GitHub credentials. Each server can also receive signed webhooks for one configured organization, including its private repositories. All API instances require PostgreSQL; replicas share stored events and live notifications through the database.

## Local development

Use Node.js 22.12 or later, npm, and Docker Compose. From a checkout of the project:

```sh
npm ci
cp .env.example .env
docker compose up -d --wait postgres
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Vite serves the frontend on port 5173 and proxies `/api` to the Express server on port 3001. Both processes run under `npm run dev`. The API connects to `DATABASE_URL` and applies its SQL migrations before accepting requests.

The first visit starts with clearly labeled fictional demo activity. Use the connection dialog to enter an organization name or its GitHub URL. A connected organization is remembered in browser local storage; its dashboard key is held only in memory and must be entered again after reloading.

The Compose service runs PostgreSQL 18 on `127.0.0.1:54329`, matching the `DATABASE_URL` in `.env.example`. Its username and password are both `ship_live` and are for local development only. Database files live in a named Docker volume mounted at `/var/lib/postgresql`, the PostgreSQL 18 image's parent data directory. `docker compose stop postgres` stops the service without removing its volume. An existing PostgreSQL database can be used instead by setting its connection URL.

To explore only the fictional frontend demo without an API or database, run `npm run dev:web`. GitHub connection and live activity need the API.

Edit `.env` and restart the API after changes. Existing process environment variables take precedence over the file. For example, a `GITHUB_TOKEN` already exported in your shell also configures this server; a blank value in `.env` does not remove that inherited token.

## Environment variables

| Variable                | Default  | Purpose                                                                                                                                                                                                                       |
| ----------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | Required | PostgreSQL connection URL for shared event history and live notifications. The local example is `postgres://ship_live:ship_live@127.0.0.1:54329/ship_live`. Use your own credentials and database for hosting.                |
| `GITHUB_ORG`            | Unset    | Organization suggested in the connection dialog. Also selects the only organization that can use server credentials, receive webhooks, and persist public polling results. Use a name such as `your-organization`, not a URL. |
| `GITHUB_TOKEN`          | Unset    | Optional server-side token used only for public API requests for `GITHUB_ORG`. Configuring it makes that feed require `DASHBOARD_ACCESS_KEY`. It does not add private events to the public endpoint.                          |
| `GITHUB_WEBHOOK_SECRET` | Unset    | Shared secret used to verify GitHub webhook signatures. Requires `GITHUB_ORG`; webhook ingestion also requires `DASHBOARD_ACCESS_KEY`.                                                                                        |
| `DASHBOARD_ACCESS_KEY`  | Unset    | Shared key viewers enter to read a protected feed and its live stream. Choose a different value from the webhook secret.                                                                                                      |
| `PORT`                  | `3001`   | Express API and production frontend port. Must be an integer from 1 to 65535.                                                                                                                                                 |
| `TEST_DATABASE_URL`     | Unset    | Dedicated PostgreSQL administration connection for integration tests. Its role must be able to create databases. The test helper creates a unique database per test and removes only that database afterward.                 |

Do not prefix secrets with `VITE_` or place them in frontend source. The bundled frontend does not need a GitHub token or webhook secret.

`DATABASE_URL` is required even for an API that serves only public activity. The server fails to start if the database is unavailable or schema setup fails. `DATA_DIR` is no longer used, and there is no automatic fallback to `events.json` or memory. Use the explicit [legacy import](#importing-an-existing-json-store) to move existing data.

Setting a token or webhook secret without `GITHUB_ORG` stops server startup. A configured token or webhook secret without a dashboard key causes protected feed requests to return `503`. Setting `DASHBOARD_ACCESS_KEY` alone does **not** protect otherwise public feeds or the frontend page.

If you change `PORT` during development, update the `/api` target in [`vite.config.ts`](../vite.config.ts) as well. Production serves frontend and API together and does not use the Vite proxy.

## Public activity

Connect an organization in the UI to browse its public activity. No token or webhook is necessary for an unprotected feed.

The browser requests the feed every 30 seconds while live updates are enabled. The server fetches `https://api.github.com/orgs/{org}/events?per_page=100`, uses ETags, and waits at least 60 seconds between upstream requests for an organization. A longer GitHub `X-Poll-Interval` is respected. Concurrent requests for the same organization share one upstream request.

This endpoint supplies limited recent public activity and can lag work on GitHub. The interface reports a possible delay of 30 seconds to 6 hours. One request reads at most 100 upstream events; unsupported actions are then excluded. There is no pagination or historical backfill. See GitHub's [events API documentation](https://docs.github.com/en/rest/activity/events).

Public polling is driven by browser requests, not an independent background worker. If no browser requests the feed, ship.live does not continually poll GitHub. Webhook ingestion continues as long as the server is running.

When `GITHUB_ORG` is configured, its public events are merged into PostgreSQL. Public feeds for other organizations use an in-memory server cache and are not persisted by that instance. A `GITHUB_TOKEN`, when provided, is sent only for the configured organization's requests and is never forwarded to the browser. Responses are still filtered to explicitly public events belonging to that organization.

## Live and private activity

Private repository activity reaches ship.live through an organization webhook. A server token is optional for this flow.

1. Set `GITHUB_ORG`, `GITHUB_WEBHOOK_SECRET`, and `DASHBOARD_ACCESS_KEY` in the server environment. Use separate random values for the two secrets. To generate a value locally, run the following command once for each secret and copy its output into your environment file or hosting secret settings:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

2. Run ship.live at a publicly reachable HTTPS address with `DATABASE_URL` pointing to persistent PostgreSQL storage.

3. In the GitHub organization's **Settings → Webhooks**, create a webhook with these settings:

   | Setting      | Value                                                         |
   | ------------ | ------------------------------------------------------------- |
   | Payload URL  | `https://your-host/api/webhooks/github`                       |
   | Content type | `application/json`                                            |
   | Secret       | The exact value of `GITHUB_WEBHOOK_SECRET`                    |
   | Events       | Pull requests, Pull request reviews, Pushes, Issues, Releases |
   | Active       | Enabled                                                       |

4. Check the webhook's recent deliveries. A valid initial `ping` returns `200` with `Webhook connected.` A supported activity delivery returns `202`; an authenticated action the app does not display returns `202` with `ignored: true`.

5. Connect the organization in ship.live and enter `DASHBOARD_ACCESS_KEY`. This is your ship.live viewer key, not a GitHub token.

Organization administration access is needed to create the webhook. ship.live does not create one automatically or install a GitHub App.

The server verifies `X-Hub-Signature-256` against the exact raw request body before parsing JSON. It then validates the delivery headers, organization, and repository ownership. Only accepted events are saved and emitted to connected viewers. See GitHub's [signature validation guide](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

The selected webhook categories do not imply that every action is displayed:

| GitHub event        | Displayed activity                                                                   |
| ------------------- | ------------------------------------------------------------------------------------ |
| Pull request        | Opened PRs and merged PRs; reopening and closing without a merge are ignored.        |
| Pull request review | Submitted approvals, comments, and requests for changes.                             |
| Push                | Pushes except deleted refs; one event represents the push, not one point per commit. |
| Issue               | Closed issues, excluding `not_planned` closures and PR-shaped issue payloads.        |
| Release             | Published, non-draft releases.                                                       |

## Production

Build the frontend and run the production entry point:

```sh
npm ci
npm run build
npm start
```

The production entry point sets production mode and serves `dist` together with the API on `PORT`, defaulting to [http://localhost:3001](http://localhost:3001). The server runs TypeScript with the runtime `tsx` dependency. After a successful build, `npm prune --omit=dev` can remove build and test dependencies before starting the service.

Use a process manager or hosting service to keep the API running. Put an HTTPS reverse proxy in front of it and serve the frontend and `/api` from the same origin. Preserve streaming responses for `/api/events`: disable response buffering and allow connections to remain open across the server's 25-second heartbeat interval.

Provision a PostgreSQL database and set `DATABASE_URL` in the hosting environment. This repository supplies local Compose configuration; it does not choose or provision a remote database. The app passes connection URL options to the `pg` driver. Follow your provider's TLS and trusted-certificate instructions, and keep certificate verification enabled. The URL is a server secret.

Use a direct PostgreSQL endpoint or a pooler in **session mode**. Each process holds a dedicated connection for `LISTEN`, separate from its query pool. A transaction-mode pooler cannot preserve that listener session. Include both the query pools and dedicated listener connections when sizing database connection capacity.

Schema migrations run automatically at startup. To apply them explicitly before starting a deployment, run:

```sh
npm run db:migrate
```

The database role needs permission to create and update the application's tables and migration ledger. Concurrent startup migrations are serialized with a PostgreSQL advisory lock. Back up the database before upgrading, and verify the app version supports the installed schema before rolling back application code.

Multiple replicas can use the same database. All replicas for one organization must have the same `GITHUB_ORG`, `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, and `DASHBOARD_ACCESS_KEY` settings so requests behave consistently. A webhook accepted by one replica becomes visible to authorized SSE clients on the others through PostgreSQL notifications; browser polling recovers missed notifications.

Instances for different organizations can also share the database, but each instance serves protected activity only for its own configured organization. A dashboard key on one instance does not authorize another organization's protected records. These are application access checks, not isolation from database administrators or other applications with database credentials.

There is no built-in TLS termination or user account system. A company access gateway can protect the UI and API; allow GitHub deliveries to reach the webhook endpoint, which performs its own signature verification. Request limits and upstream caches remain per process, so use a gateway if you need a shared limit across replicas.

Back up PostgreSQL using your database provider or standard PostgreSQL tooling, protect the backups, and test restoration. The app does not expire events or accepted delivery IDs automatically; monitor storage growth. The server closes its live responses, dedicated listener, and query pool on graceful shutdown.

## Access and storage boundaries

The dashboard key is shared access control for a trusted team. Feed and SSE requests use the `x-dashboard-key` header. The key is not put in URLs or persisted in browser storage. There is no individual login, per-repository authorization, or viewer audit trail.

The public `/api/health` endpoint checks database connectivity and returns server status, the configured organization name, and whether protection and webhooks are configured. It does not expose credential values. A failed database check makes the health request fail, so use it for readiness checks. Other unprotected public organizations remain browsable without the configured organization's dashboard key.

Configuring a GitHub token or webhook secret marks the organization as protected in PostgreSQL, and webhook ingestion preserves that marker. It survives removal of those credentials, so saved restricted activity is not silently made public. If credentials are removed and no dashboard key is available, protected feed requests fail closed. Do not edit the store to bypass its protection metadata.

Stored activity may contain private repository names, contributor logins, titles, and URLs. PostgreSQL stores normalized events as JSONB together with organization protection metadata and the delivery ledger. Raw webhook payloads are not retained. Protect database access, connections, storage, and backups; the app does not encrypt individual event fields.

## Importing an existing JSON store

The previous file-backed version stored its data in `.data/events.json` by default. Stop the old application writer and take a backup of that file before switching to PostgreSQL. Preserve the old server's organization and credential configuration.

Set the destination `DATABASE_URL`, then run the importer with the source file path:

```sh
npm run db:import-json -- .data/events.json
```

The importer validates the complete version-1 file before opening the database. It applies the SQL schema if needed, then imports the events, accepted delivery IDs, and organization protection metadata in one transaction. If an import write fails, all import writes roll back. Schema migration is a separate transaction.

Reimporting is safe: existing event and delivery IDs are reconciled, existing event versions are preserved except when an earlier issue closure must remain canonical, and protection can only be added. Protected organizations with no retained events remain protected. The command prints counts of newly inserted events, delivery IDs, and newly protected organizations.

The source file is never changed or deleted. Start the new app and verify the protected feed before retiring the backup. The importer cannot recover events already discarded by the old store's retention limit, and the current UI still shows only the latest 2,000 events per organization. Keep legacy files and database dumps out of Git and outside the static web root.

## Database tests

Start the local Compose database, then explicitly provide a dedicated test administration connection:

```sh
TEST_DATABASE_URL=postgres://ship_live:ship_live@127.0.0.1:54329/postgres npm run test:db
```

`npm run test:db` runs the full test suite and fails immediately if `TEST_DATABASE_URL` is missing. `npm test` runs the same tests but marks database integration tests as skipped when that variable is absent. Test scripts do not load `.env` automatically or fall back to `DATABASE_URL`. CI supplies PostgreSQL and always runs the database tests.

The helper uses `TEST_DATABASE_URL` only to create uniquely named `ship_live_test_*` databases. Each test opens its own database; teardown terminates connections to that database and drops it. It never migrates or drops the configured administration database. Use a dedicated test server or role with `CREATE DATABASE` permission, and keep test credentials separate from production.

## Limits and recovery

| Limit                  | Current behavior                                                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retained events        | All normalized events persisted for configured organizations; no automatic expiration. The API and browser expose only the latest 2,000 per organization, ordered by event time. |
| Delivery deduplication | Accepted activity delivery IDs are unique across the shared database and do not expire automatically.                                                                            |
| Webhook body           | Maximum 2 MB; larger payloads return `413`.                                                                                                                                      |
| Live streams           | Maximum 100 simultaneous SSE connections per server process; additional streams return `503`, while polling remains available.                                                   |
| API requests           | 120 requests per minute per observed IP per app process; health and webhook routes are excluded.                                                                                 |
| Upstream request       | 10-second timeout; upstream failures and rate limits are temporarily cached.                                                                                                     |

Express does not enable `trust proxy`. Behind a reverse proxy, multiple viewers can share the proxy's observed IP and therefore the same API request allowance. The application does not currently expose a proxy-trust setting.

Webhook delivery deduplication, canonical event writes, and protection metadata commit together in PostgreSQL. Notifications contain only an organization and event ID and are delivered after the transaction commits. Listening processes read the stored event before sending it to their clients. Notifications are not a durable queue: disconnected listeners can miss references, then reconnect while browser polling reads the saved feed.

When GitHub temporarily fails, the configured organization's previously saved activity can be returned with a notice. An upstream organization `404` is not replaced with a saved-data response. If a live stream disconnects, the browser retries after 10 seconds and normal polling reconciles saved events. The stream itself does not support cursor-based historical replay.

If a feed is empty, first check the selected organization, time window, filters, and GitHub webhook deliveries. Public API history and the browser's 2,000-event limit can make weekly totals incomplete even when older events exist in the database. Changing the replay window does not fetch additional history.

## Customizing recognition

Base XP values and weekly team targets live in [`src/lib/activity.ts`](../src/lib/activity.ts). Modify those definitions in source to change the rules; there is no administrative settings API. For how those rules differ from the visible Orbit timeline, see [Architecture](architecture.md).
