# Railway deployment

ship.live runs its built React interface and Express API in one Node.js service. Supabase provides Google/GitHub sign-in; PostgreSQL can live in Supabase or Railway. The backend uses `DATABASE_URL` and standard PostgreSQL, so the database provider remains replaceable. No separate frontend host, Redis instance, or worker is required.

Free plans are suitable for trying the app. Do not assume they can fund an always-on activity wall and database. This assessment was checked against the providers' official documentation on **September 7, 2026**; it is not a measured bill or a deployed benchmark.

## Choose where to host PostgreSQL

| Option                                       | Services                                                 | Tradeoff                                                                                                                                                                                                                                                                      |
| -------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Supabase Auth + PostgreSQL, Railway Node** | One Supabase project and one Railway application service | Recommended starting point: uses the database already included with Supabase Auth and reduces Railway compute/storage usage. Database traffic crosses providers and consumes egress; Supabase Free quotas and inactivity pausing apply to both identity and application data. |
| Supabase Auth, Railway Node + PostgreSQL     | One Supabase project and two Railway services            | Useful when the database needs independent hosting or Railway's internal network. The application database remains running independently of Supabase, but sign-in still depends on Supabase Auth. Railway bills database compute and its volume.                              |

These choices use the same application data model and API authorization. Hosting the database in Supabase does not make private journals or team workspaces public, and it does not mean the browser should query those tables directly.

## Supabase Free limits

Supabase Free includes **50,000 monthly active users**, **500 MB database size**, **5 GB uncached egress**, **5 GB cached egress**, and two active projects. Free projects pause after one week of inactivity. Pro starts at $25/month and includes the first project's baseline compute. An active prototype can fit the Free quotas; an availability-sensitive production service should budget for a plan without inactivity pausing. [Supabase pricing](https://supabase.com/pricing)

Database results through Supavisor count toward uncached egress, shared with services such as Auth. The separate cached allowance does not double the database allowance. As a sensitivity example, a 500 KB database result fetched every 30 seconds for eight hours a day, 22 days a month transfers approximately 10.56 GB for one active viewer. Actual results may be much smaller; measure payload size and query frequency instead of judging cost only by stored database size. [Supabase egress accounting](https://supabase.com/docs/guides/platform/manage-your-usage/egress)

## Free tier and expected cost

| Plan             | Included usage and relevant limits                                                                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trial            | $5 credit for up to 30 days; up to 1 GB RAM per service.                                                                                                                                                         |
| Free after trial | $1 credit per month; one project, three services, one replica per service, up to 1 vCPU and 0.5 GB RAM per service, and 0.5 GB volume storage. No custom domain after the trial; use a generated Railway domain. |
| Hobby            | $5 monthly minimum, including $5 of resource usage; additional usage is billed.                                                                                                                                  |
| Pro              | $20 monthly minimum, including $20 of usage; intended for teams running production services.                                                                                                                     |

These are resource ceilings, not a promise of free continuous runtime. [Railway pricing](https://railway.com/pricing)

Railway lists RAM at $10/GB-month, CPU at $20/vCPU-month, volumes at $0.15/GB-month, and service egress at $0.05/GB. Two illustrative estimates, not measurements:

- Node alone at 0.2 GB average RAM, 0.01 vCPU, and 1 GB egress: approximately **$2.25/month** in Railway usage, plus any Supabase charges.
- Node and Railway PostgreSQL together at 0.4 GB RAM, 0.02 vCPU, 0.5 GB stored data, and 1 GB egress: approximately **$4.53/month** in Railway usage, plus any Supabase Auth charges.

Either example is a $5 Railway bill on Hobby because of the minimum. Traffic, syncs, indexes, and backups can increase usage. [Resource pricing and included credits](https://docs.railway.com/pricing/plans)

The $1 monthly allowance covers only about 0.1 GB of continuously used RAM before any other charges. The Free plan's small persistent volume also leaves limited room for a growing event history. New accounts may have restricted outbound network access until Railway verifies them, which must be checked before relying on GitHub API calls. Trial volumes have a deletion policy after credits expire. [Trial restrictions and retention](https://docs.railway.com/pricing/free-trial)

## Why sleeping does not make this reliably free

The app maintains a PostgreSQL `LISTEN` connection with TCP keepalive. Open dashboards receive an SSE heartbeat every 25 seconds and refresh the feed every 30 seconds. These behaviors are deliberate: they support webhook updates and recover missed notifications.

Railway's Serverless mode requires no outbound traffic for roughly 5–10 minutes before sleeping. Active database connections and service-to-service traffic can prevent sleep. A cold first request may return `502`. Consequently, keep Serverless disabled for reliable webhook ingestion and an always-on wall; do not use sleep savings as the basis for the budget. [Serverless behavior](https://docs.railway.com/deployments/serverless)

Railway limits a continuously transferring HTTP request to 15 minutes. SSE connections can therefore close periodically; the frontend reconnects and reconciles events through polling. This is expected behavior, not evidence of lost database records. [Public networking limits](https://docs.railway.com/networking/public-networking/specs-and-limits)

## Deploy the application

1. Create a Supabase project for authentication. Connect a Railway application service to your fork of this repository. Choose a database location from the options above and keep the app and database geographically close.
2. Configure the application service's `DATABASE_URL` using the database instructions below.
3. Configure the application service as follows:

   | Setting             | Value                                       |
   | ------------------- | ------------------------------------------- |
   | Root directory      | Repository root                             |
   | Builder             | Railpack / Node.js                          |
   | Build command       | `npm run build`                             |
   | Start command       | `npm start`                                 |
   | Healthcheck path    | `/api/health`                               |
   | Healthcheck timeout | `300` seconds                               |
   | Replicas            | `1` initially                               |
   | Serverless          | Disabled for reliable live ingestion        |
   | App volume          | None; persistent data belongs in PostgreSQL |

   The build needs development dependencies for TypeScript and Vite. `tsx` is a runtime dependency. The server honors Railway's injected `PORT`; do not run the Vite development server in production. Startup applies database migrations before accepting requests. [Express deployment](https://docs.railway.com/guides/express)

4. Generate an HTTPS domain for the application service, then configure authentication and the GitHub App using the final public URL. Store secrets as Railway service variables, never in the repository or variables prefixed with `VITE_`. See [configuration](configuration.md) for the authentication variables and GitHub callback settings.
5. Deploy and check `/api/health`. Railway uses this endpoint when promoting the deployment; it does not keep monitoring it afterward. [Healthchecks](https://docs.railway.com/deployments/healthchecks)

The app defaults to `TRUST_PROXY_HOPS=0`, so request limits use the immediate peer's IP. Behind a proxy that can group users into one limit. Set this to the verified, fixed number of trusted forwarding proxies (an integer from 1 to 5) only when every ingress path has that count, direct/shorter access is prevented, and the proxies remove or overwrite untrusted forwarding headers. For a verified single-edge path, use `1`; re-evaluate when adding a CDN or another proxy. Do not enable blanket proxy trust. `/api/health` is exempt from request limits. [Express proxy configuration](https://expressjs.com/en/guide/behind-proxies.html)

These instructions use service settings because Railway now deprecates the older `railway.json` / `railway.toml` deployment format. Its documentation directs new infrastructure definitions to Infrastructure as Code; this repository does not include a legacy file that may stop working. [Configuration format status](https://docs.railway.com/config-as-code/reference)

### Supabase database connection

Copy **Session pooler** from the Supabase project's Connect dialog. The shared Supavisor endpoint on **port 5432** supports IPv4 and persistent sessions. Store the complete connection string, including the project-specific username, as `DATABASE_URL` in Railway. The `LISTEN` connection needs a stable session: do **not** select the transaction pooler on port 6543. Keep the number of application replicas and database pool connections within the project's connection limit. [Supabase connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres)

A direct Supabase connection is another option when outbound IPv6 is available. Railway supports outbound IPv6 as an opt-in service setting; it is disabled by default and enabling it requires redeployment. Session pooling avoids needing that setting or a paid Supabase IPv4 add-on. [Railway outbound networking](https://docs.railway.com/networking/outbound-networking)

Enable TLS and certificate/hostname verification using Supabase's current CA configuration for your endpoint. Do not fix certificate failures with `rejectUnauthorized: false` or by disabling SSL. [Supabase SSL enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement)

Supabase is outside Railway's private network. Responses leaving Supabase consume its egress allowance; queries/writes leaving Railway and responses sent to browsers consume Railway egress. Using an external database reduces database compute charges on Railway, not all network charges. [Railway cost control](https://docs.railway.com/pricing/cost-control)

### Railway database connection

Add a PostgreSQL service in the same Railway project environment as the application. Set `DATABASE_URL=${{Postgres.DATABASE_URL}}`, replacing `Postgres` with the actual service name. Use the private URL, not `DATABASE_PUBLIC_URL`; the database does not need public access. Persistent storage belongs on this PostgreSQL service, not the application container. [Railway PostgreSQL connections](https://docs.railway.com/databases/postgresql)

## Configure social sign-in

Enable Google and GitHub in Supabase Auth. Their OAuth client secrets belong in Supabase's provider settings. The provider callback is the URL displayed there, typically `https://<project-ref>.supabase.co/auth/v1/callback`; the subsequent redirect to ship.live is a separate URL. Use the deployed app's HTTPS origin as the Site URL and allow the narrow callback pattern, including its flow query parameter, specified in [configuration](configuration.md#set-up-google-and-github-sign-in). [Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google), [GitHub setup](https://supabase.com/docs/guides/auth/social-login/auth-github), [redirect configuration](https://supabase.com/docs/guides/auth/redirect-urls)

GitHub sign-in identifies the person. Installing the ship.live GitHub App separately grants selected repository access for activity ingestion. Google users can also connect that GitHub App; signing in alone does not authorize access to an organization's private repositories.

Basic Google/GitHub OAuth does not require an email delivery workflow. If you later enable email invitations, magic links, or email confirmation, configure custom SMTP in Supabase first: its default mailer is restricted to project-team addresses and currently two messages per hour. [Supabase email delivery](https://supabase.com/docs/guides/auth/auth-smtp)

## Protect the hosted data

All application data access goes through the authenticated Express API. When using Supabase PostgreSQL, disable its unused **Data API** in the project's Data API integration settings. SQL-created tables in an exposed schema can otherwise receive automatic grants to `anon` or `authenticated` on existing projects, bypassing the application API. Keep explicit grants/RLS restrictions on application tables as well; a publishable Auth key must not become a route to another user's notes or organization data. [Supabase Data API security](https://supabase.com/docs/guides/api/securing-your-api)

For Railway PostgreSQL, keep the service private and share its credentials only with this application and trusted operators. Railway's private network encrypts service traffic and isolates project environments. [Private networking](https://docs.railway.com/networking/private-networking)

Use separate databases and GitHub App credentials for preview and production deployments. Do not expose production secrets to builds from untrusted forks. Configure database backups and test restoring them; a persistent volume alone is not a backup. Operators who can access the database, runtime secrets, or backups remain trusted parties. [Volume backups](https://docs.railway.com/volumes/backups)

Set a usage alert and review actual memory, CPU, disk, and egress after a representative week. A hard spending limit stops services when reached, so it trades availability for cost control. [Usage limits](https://docs.railway.com/pricing/cost-control)
