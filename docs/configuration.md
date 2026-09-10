# Configuration and hosting

ship.live uses Supabase for Google/GitHub sign-in and PostgreSQL for private journals, GitHub connections, event history, and shared session revocation. A separate GitHub App connects personal accounts or organizations and receives live activity. The browser uses the Express API for application data.

## Local development

Use Node.js 22.12+, npm, and Docker Compose:

```sh
npm ci
cp .env.example .env
docker compose up -d --wait postgres
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173), matching `APP_URL`. Vite proxies `/api` to Express on port 3001. The API requires PostgreSQL and applies migrations before accepting requests. If you change the API port, update the development proxy in [`vite.config.ts`](../vite.config.ts).

The Compose service runs PostgreSQL 18 on `127.0.0.1:54329`. Its `ship_live` username/password are development defaults. A named volume holds its files; `docker compose stop postgres` stops the service without deleting that volume. For frontend-only demo work, `npm run dev:web` needs no database.

The demo uses fictional events and needs no external credentials. Real journals require Supabase sign-in. A signed-in user can write personal notes before connecting GitHub. Edit `.env` and restart the API after changes; exported process variables take precedence over the file.

## Environment variables

| Variable                   | Purpose                                                                                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`             | Required PostgreSQL connection. Supabase PostgreSQL, Railway PostgreSQL, and other compatible providers are supported.                                                |
| `PORT`                     | Server port, default `3001`; Railway supplies it automatically.                                                                                                       |
| `APP_URL`                  | Exact browser origin, required for configured sign-in. HTTPS when hosted; HTTP only on loopback. No path, query, credentials, or fragment.                            |
| `TRUST_PROXY_HOPS`         | Trusted forwarding proxy count, `0` by default, integer `0`–`5`. Set only for a verified fixed ingress path; see [proxy guidance](railway.md#deploy-the-application). |
| `SUPABASE_URL`             | Supabase project origin. Configure together with the publishable key.                                                                                                 |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase publishable Auth key. Legacy `SUPABASE_ANON_KEY` is accepted. Secret/service-role keys are rejected.                                                         |
| `SUPABASE_GOOGLE_ENABLED`  | `true` by default when Auth is configured; `false` disables this login option. Enable the provider in Supabase too.                                                   |
| `SUPABASE_GITHUB_ENABLED`  | Same behavior for GitHub sign-in.                                                                                                                                     |
| `GITHUB_APP_ID`            | Numeric ID of the GitHub App used for repository data.                                                                                                                |
| `GITHUB_APP_CLIENT_ID`     | That App's OAuth client ID, distinct from its numeric App ID.                                                                                                         |
| `GITHUB_APP_CLIENT_SECRET` | That App's OAuth client secret.                                                                                                                                       |
| `GITHUB_APP_PRIVATE_KEY`   | RSA PEM private key from the App settings. Quoted PEM text with escaped `\n` line breaks is accepted.                                                                 |
| `GITHUB_APP_SLUG`          | App slug from its installation URL.                                                                                                                                   |
| `GITHUB_WEBHOOK_SECRET`    | Random secret configured on the GitHub App webhook.                                                                                                                   |
| `TOKEN_ENCRYPTION_KEY`     | Exactly 64 hexadecimal characters representing 32 random bytes. Encrypts GitHub user and refresh tokens in PostgreSQL.                                                |
| `TEST_DATABASE_URL`        | Dedicated test administration connection with `CREATE DATABASE` permission. Never use production for tests.                                                           |

Configure all GitHub App fields and `TOKEN_ENCRYPTION_KEY` together, or leave the integration unconfigured. Partial credentials fail startup; there is no personal-token or shared-dashboard-key fallback. None of these variables belong in `VITE_*` or frontend source. The frontend does not receive provider tokens or database credentials.

Generate an encryption key or webhook secret locally, using a separate value for each purpose. Store the output in your secret manager or ignored `.env`:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## Set up Google and GitHub sign-in

1. Create a Supabase project. It may also host the application database, but Auth and database hosting can be separate.
2. Enable **Google** and **GitHub** in Supabase Auth. Register a Google web OAuth client and a GitHub **OAuth App** for login. Put their client IDs and secrets in Supabase's provider settings. Use basic identity scopes; repository access belongs to the separate GitHub App below.
3. For both providers, use the callback Supabase displays, normally `https://<project-ref>.supabase.co/auth/v1/callback`. This provider-to-Supabase callback is not a ship.live API route.
4. Set Supabase's **Site URL** exactly to `APP_URL`. The app returns through `APP_URL/api/auth/callback?flow=...`. For additional development/staging origins, allow a narrow callback pattern such as `http://127.0.0.1:5173/api/auth/callback*`; the flow query must be permitted. Avoid broad production-domain wildcards.
5. Set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `APP_URL` on Express, restart, and test both sign-in buttons.

The app creates a browser-bound, single-use login transaction and uses Supabase's PKCE flow. It verifies the resulting user with Supabase before creating an opaque app session. Both Supabase session cookies and the app session cookie are `HttpOnly`, `SameSite=Lax`, host-only, and `Secure` on HTTPS. No browser Supabase client or localStorage token persistence is used. [Supabase server-side Auth](https://supabase.com/docs/guides/auth/server-side/creating-a-client), [Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google), [GitHub setup](https://supabase.com/docs/guides/auth/social-login/auth-github).

Supabase automatically links OAuth identities with matching email addresses under its identity-linking rules. ship.live uses the resulting Supabase UUID and does not implement its own email-matching account system. Login never grants private GitHub repository access by itself; connecting the data App is an explicit authenticated action. [Supabase identity linking](https://supabase.com/docs/guides/auth/auth-identity-linking).

Keep the browser and API on the same origin. Switching between `localhost` and `127.0.0.1` changes cookie scope and can invalidate login. Preview deployments need their own trusted URL configuration and separate credentials/data.

## Set up the GitHub App for activity

This is a **GitHub App**, separate from the GitHub OAuth App used by Supabase. A person who signs in through Google can then authorize it to connect GitHub.

Register an App installable on the personal accounts and organizations you intend to support:

| GitHub App setting                             | Value                                                          |
| ---------------------------------------------- | -------------------------------------------------------------- |
| User authorization callback                    | `APP_URL/api/github/callback`                                  |
| Setup URL                                      | `APP_URL/?github=installed`                                    |
| Webhook URL                                    | `APP_URL/api/webhooks/github`                                  |
| Webhook secret                                 | Match `GITHUB_WEBHOOK_SECRET`                                  |
| User-to-server token expiration                | Enabled                                                        |
| Request user authorization during installation | Disabled; ship.live initiates its own browser-bound OAuth flow |
| Device flow                                    | Not needed                                                     |

Use a publicly reachable HTTPS URL for actual webhook delivery. The setup return is navigation only: a returned `installation_id` does not prove ownership. The server verifies installations and repositories using the current user's GitHub App user token when that user connects, refreshes, or syncs; ordinary reads use the stored result. [GitHub setup URL security](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url).

Grant **read-only** repository permissions: Metadata, Pull requests, Issues, Contents, Actions, Checks, Commit statuses, and Deployments, plus the **read-only** organization permission Members. Subscribe to pull request, pull request review, issues, push, release, check run, status, workflow run, deployment, deployment status, organization, membership, team, and member events. Lifecycle and membership events drive revocation handling: organization member, team, and repository collaborator changes update each viewer's stored repository access without waiting for a sync. Existing installations must approve added permissions before engineering-wall signals and membership updates arrive; until an organization approves Members, access changes apply at each viewer's next sync. No write permission, source cloning, source-file download, CI logs, or check annotations are needed by ship.live. [GitHub webhook permissions](https://docs.github.com/en/webhooks/webhook-events-and-payloads).

Generate the App's private key and populate the server variables. In ship.live:

1. Sign in and choose **Connect GitHub**.
2. Authorize the App. Install it on a personal account or organization if needed, choosing **Only select repositories** for the scope you want.
3. Return to ship.live and choose an installation/workspace. The server lists only installations and repositories available to that GitHub user.
4. Synchronize recent activity. Sync also re-reads repository access; run it, or choose **Refresh** in account settings, after changing access in GitHub. New signed webhooks update authorized open dashboards.

Manage repository selection in GitHub's installation settings. Users do not need to paste personal access tokens or shared dashboard keys.

## Personal and team privacy

Every account has a private personal journal. Notes accept a title up to 200 characters and a body up to 10,000 characters; only their owner may read, create, or delete them. Notes earn zero XP.

A team workspace is associated with a verified installation. Each viewer must connect GitHub. The server filters activity by immutable repository IDs that both the App and that viewer could access at the viewer's last sync. Installation repository selections, organization membership, team, and collaborator changes apply through webhooks; changes GitHub does not announce, such as an organization's base permission, apply at the viewer's next sync. Organization membership alone does not grant every private repository. Totals, repository names, search results, and live updates are derived from the permitted events.

Authorization is rechecked during asynchronous reads and before streaming. Expired/revoked sessions, revoked repository access, suspended/deleted installations, or unavailable authorization services do not fall back to cached private responses. Removing repositories or an installation invalidates related ingestion/access state. A setup callback or webhook sender alone cannot claim a workspace.

Disconnecting GitHub removes your stored user grant and workspace associations; it preserves your journal notes. It does not uninstall the GitHub App or erase stored event history. An installed App can continue delivering webhooks for other connected viewers. To stop delivery for an installation, uninstall or suspend the App in GitHub. Historical data follows the host operator's retention policy.

## History and live updates

Synchronization imports a bounded part of the last 30 days: up to 100 PRs, 100 closed issues, and 100 releases per repository, plus the first 100 reviews for up to 30 recently updated PRs. The server processes selected repositories in batches of at most 20. The UI reports partial history and failures. Push activity begins with received webhooks; synchronization is not a complete archive.

Signatures are checked against the raw webhook body before parsing. Supported events are normalized and reconciled by event identity, with delivery deduplication in PostgreSQL. Stored history does not expire automatically; the API/UI expose up to 2,000 latest events per workspace. Upstream limits and permission changes can affect metrics.

PostgreSQL `LISTEN`/`NOTIFY` distributes event references between replicas. Instances read stored events and authorize their viewers before emitting SSE data. Notifications do not include private event titles. Browser polling reconciles missed notifications. Pausing a browser's live updates does not stop webhook ingestion.

## Production and database access

```sh
npm ci
npm run build
npm start
```

Production serves frontend and API from one Node process. Use HTTPS and preserve SSE responses across the 25-second heartbeat. The server honors `PORT`. The [Railway guide](railway.md) covers database choices, free-plan limits, deployment, and networking.

Use a direct PostgreSQL endpoint or **session-mode** pooler. Each process uses a query pool and a dedicated `LISTEN` session; transaction pooling cannot preserve the listener. For Supabase on an IPv4 host, use its session pooler on port 5432. Preserve provider-recommended TLS certificate/hostname verification.

For Supabase PostgreSQL, disable the unused **Data API**. Migrations enable RLS and revoke `PUBLIC`, `anon`, and `authenticated` access to application tables. No browser Data API policies are provided. The backend database owner can bypass RLS, so Express workspace/repository authorization remains essential. The app does not need a service-role Auth key. [Supabase API protection](https://supabase.com/docs/guides/api/securing-your-api).

Startup applies migrations under a PostgreSQL advisory lock. To apply them separately, run `npm run db:migrate`. Database or migration failure prevents startup. Replicas need the same Auth, GitHub App, encryption key, and public-origin configuration. `/api/health` checks PostgreSQL; it does not prove provider registration or webhook configuration.

Process-local limits are not shared quotas. Protect runtime secrets, database access, and backups. Event text and notes are not end-to-end encrypted; provider-token encryption does not prevent trusted operators from reading application data.

## Upgrading an existing installation

Back up PostgreSQL and securely preserve the encryption key. The current server uses authenticated workspace routes. `GITHUB_ORG`, `GITHUB_TOKEN`, and `DASHBOARD_ACCESS_KEY` no longer configure its runtime; old organization/key feed routes are not mounted. Remove stale settings and configure Supabase and the GitHub App instead.

Existing organization-scoped events remain in legacy namespaces. They are **not automatically claimed** by a matching organization name, email, installation callback, or first login. A verified installation imports current accessible GitHub history into the new model. Moving older private history requires an operator-reviewed mapping; no automatic claim tool is provided.

The JSON importer can still recover a version-1 store into the legacy namespace:

```sh
npm run db:import-json -- /absolute/path/to/events.json
```

It validates the whole file and preserves event identity, delivery IDs, and protection metadata transactionally. It does not modify/delete the source or make imported legacy records visible to signed-in workspaces. Keep files and dumps outside Git and the static web root. `DATA_DIR` is unused; there is no production JSON fallback.

## Database tests

```sh
TEST_DATABASE_URL=postgres://ship_live:ship_live@127.0.0.1:54329/postgres npm run test:db
```

Use a dedicated admin connection with `CREATE DATABASE` permission. The helper creates uniquely named databases and drops only those databases; it never migrates the administration database. Tests do not load `.env` or use `DATABASE_URL`. `npm test` skips integration tests without `TEST_DATABASE_URL`; CI requires the full suite.

Auth tests use real Express/PostgreSQL with mocked Supabase responses; GitHub client tests mock its API. These cover permission/session boundaries but do not replace real OAuth and installation smoke tests using your provider accounts and public deployment.
