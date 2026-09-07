# Configuration and hosting

ship.live can browse public GitHub organization activity without credentials. A single server can also receive signed webhooks for one configured organization, including its private repositories.

## Local development

Use Node.js 22.12 or later and npm. From a checkout of the project:

```sh
npm ci
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Vite serves the frontend on port 5173 and proxies `/api` to the Express server on port 3001. Both processes run under `npm run dev`.

The first visit starts with clearly labeled fictional demo activity. Use the connection dialog to enter an organization name or its GitHub URL. A connected organization is remembered in browser local storage; its dashboard key is held only in memory and must be entered again after reloading.

An optional environment file configures the server:

```sh
cp .env.example .env
```

Edit `.env` and restart the API after changes. Existing process environment variables take precedence over the file. For example, a `GITHUB_TOKEN` already exported in your shell also configures this server; a blank value in `.env` does not remove that inherited token.

## Environment variables

| Variable                | Default | Purpose                                                                                                                                                                                                                       |
| ----------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_ORG`            | Unset   | Organization suggested in the connection dialog. Also selects the only organization that can use server credentials, receive webhooks, and persist public polling results. Use a name such as `your-organization`, not a URL. |
| `GITHUB_TOKEN`          | Unset   | Optional server-side token used only for public API requests for `GITHUB_ORG`. Configuring it makes that feed require `DASHBOARD_ACCESS_KEY`. It does not add private events to the public endpoint.                          |
| `GITHUB_WEBHOOK_SECRET` | Unset   | Shared secret used to verify GitHub webhook signatures. Requires `GITHUB_ORG`; webhook ingestion also requires `DASHBOARD_ACCESS_KEY`.                                                                                        |
| `DASHBOARD_ACCESS_KEY`  | Unset   | Shared key viewers enter to read a protected feed and its live stream. Choose a different value from the webhook secret.                                                                                                      |
| `DATA_DIR`              | `.data` | Directory for `events.json`, resolved relative to the process working directory unless absolute. Keep it persistent across restarts.                                                                                          |
| `PORT`                  | `3001`  | Express API and production frontend port. Must be an integer from 1 to 65535.                                                                                                                                                 |

Do not prefix secrets with `VITE_` or place them in frontend source. The bundled frontend does not need a GitHub token or webhook secret.

Setting a token or webhook secret without `GITHUB_ORG` stops server startup. A configured token or webhook secret without a dashboard key causes protected feed requests to return `503`. Setting `DASHBOARD_ACCESS_KEY` alone does **not** protect otherwise public feeds or the frontend page.

If you change `PORT` during development, update the `/api` target in [`vite.config.ts`](../vite.config.ts) as well. Production serves frontend and API together and does not use the Vite proxy.

## Public activity

Connect any public organization in the UI. No token or webhook is necessary.

The browser requests the feed every 30 seconds while live updates are enabled. The server fetches `https://api.github.com/orgs/{org}/events?per_page=100`, uses ETags, and waits at least 60 seconds between upstream requests for an organization. A longer GitHub `X-Poll-Interval` is respected. Concurrent requests for the same organization share one upstream request.

This endpoint supplies limited recent public activity and can lag work on GitHub. The interface reports a possible delay of 30 seconds to 6 hours. One request reads at most 100 upstream events; unsupported actions are then excluded. There is no pagination or historical backfill. See GitHub's [events API documentation](https://docs.github.com/en/rest/activity/events).

Public polling is driven by browser requests, not an independent background worker. If no browser requests the feed, ship.live does not continually poll GitHub. Webhook ingestion continues as long as the server is running.

When `GITHUB_ORG` is configured, its public events are merged into the JSON store. Public feeds for other organizations use an in-memory server cache and are not persisted. A `GITHUB_TOKEN`, when provided, is sent only for the configured organization's requests and is never forwarded to the browser. Responses are still filtered to explicitly public events belonging to that organization.

## Live and private activity

Private repository activity reaches ship.live through an organization webhook. A server token is optional for this flow.

1. Set `GITHUB_ORG`, `GITHUB_WEBHOOK_SECRET`, and `DASHBOARD_ACCESS_KEY` in the server environment. Use separate random values for the two secrets. To generate a value locally, run the following command once for each secret and copy its output into your environment file or hosting secret settings:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

2. Run ship.live at a publicly reachable HTTPS address with a persistent `DATA_DIR`.

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

Use a process manager or hosting service to keep one Node process running. Put an HTTPS reverse proxy in front of it and route the frontend and `/api` to the same instance. Preserve streaming responses for `/api/events`: disable response buffering and allow connections to remain open across the server's 25-second heartbeat interval.

Use a persistent volume for `DATA_DIR`. Deployments that replace or discard their filesystem lose received history and delivery deduplication records. The default `.data` directory and `.env` files are ignored by Git; if you choose another directory inside the checkout, add that path to your ignore rules too.

There is no built-in TLS termination, user account system, or multi-tenant private organization support. Run separate instances with separate storage directories for separate private organizations. A company access gateway can protect the UI and API; allow GitHub deliveries to reach the webhook endpoint, which performs its own signature verification.

## Access and storage boundaries

The dashboard key is shared access control for a trusted team. Feed and SSE requests use the `x-dashboard-key` header. The key is not put in URLs or persisted in browser storage. There is no individual login, per-repository authorization, or viewer audit trail.

The public `/api/health` endpoint returns server status, the configured organization name, and whether protection and webhooks are configured. It does not expose credential values. Other public organizations remain browsable without the configured organization's dashboard key.

Webhook ingestion marks the organization as protected in the store. That marker survives removal of the webhook secret or token, so saved restricted activity is not silently made public. If credentials are removed and no dashboard key is available, protected feed requests fail closed. Do not edit the store to bypass its protection metadata.

Stored activity is plaintext JSON and may contain private repository names, contributor logins, titles, and URLs. Raw webhook payloads are not retained. The app creates the data directory with mode `0700` and new store files with mode `0600`; protect the host, backups, and existing directory permissions accordingly.

## Limits and recovery

| Limit                  | Current behavior                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Retained events        | Latest 2,000 normalized events across the store, ordered by event time. This is a count limit, not a guaranteed retention period. |
| Delivery deduplication | Last 3,000 accepted activity delivery IDs. This is a bounded ledger, not permanent delivery history.                              |
| Webhook body           | Maximum 2 MB; larger payloads return `413`.                                                                                       |
| Live streams           | Maximum 100 simultaneous SSE connections per server process; additional streams return `503`, while polling remains available.    |
| API requests           | 120 requests per minute per observed IP; health and webhook routes are excluded.                                                  |
| Upstream request       | 10-second timeout; upstream failures and rate limits are temporarily cached.                                                      |

Express does not enable `trust proxy`. Behind a reverse proxy, multiple viewers can share the proxy's observed IP and therefore the same API request allowance. The application does not currently expose a proxy-trust setting.

The store serializes writes within one process, writes a temporary file, and atomically renames it over `events.json`. It is not safe for multiple Node workers or replicas sharing that file. Use a database and coordinated ingestion before introducing multiple writers. Back up or restore the data directory while the process is stopped; malformed or unsupported store files cause startup to fail rather than being silently discarded.

When GitHub temporarily fails, the configured organization's previously saved activity can be returned with a notice. An upstream organization `404` is not replaced with a saved-data response. If a live stream disconnects, the browser retries after 10 seconds and normal polling reconciles saved events. The stream itself does not support cursor-based historical replay.

If a feed is empty, first check the selected organization, time window, filters, and GitHub webhook deliveries. Public API history and storage limits can make weekly totals incomplete. Changing the replay window does not fetch additional history.

## Customizing recognition

Base XP values and weekly team targets live in [`src/lib/activity.ts`](../src/lib/activity.ts). Modify those definitions in source to change the rules; there is no administrative settings API. For how those rules differ from the visible Orbit timeline, see [Architecture](architecture.md).
