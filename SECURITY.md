# Security

ship.live is an early self-hosted application. Security fixes target the latest code on `main`; there is no supported long-term release branch yet.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/vndee/ship.live/security/advisories/new) when it is enabled. If the private report form is unavailable, contact the maintainer through the contact methods on [their GitHub profile](https://github.com/vndee) to arrange a private channel before sharing details. Do not put an exploit, credentials, or private organization data in a public issue.

Include the affected version or commit, reproduction steps with synthetic data, the impact, and any proposed fix. Remove database connection URLs, access keys, GitHub tokens, webhook secrets, and private payloads from attachments.

## Deployment assumptions

- Keep `DATABASE_URL`, GitHub tokens, webhook secrets, and dashboard keys on the server. Never put them in `VITE_*` variables or frontend source.
- Use different random values for `GITHUB_WEBHOOK_SECRET` and `DASHBOARD_ACCESS_KEY`. Deliver webhooks and serve dashboards over HTTPS.
- A dashboard key is shared access for a trusted team, not individual authentication. Put private instances behind your organization's access controls.
- PostgreSQL activity can contain private titles, repository names, and contributor information. Restrict database access, use your provider's TLS and trusted-certificate settings, and protect database storage and backups. The app does not encrypt individual event fields.
- All replicas serving the same organization must use consistent GitHub and dashboard credentials. Instances for different organizations may share PostgreSQL, but each instance authorizes only its own protected organization. These checks do not isolate data from database administrators or applications with database access.
- Organization protection markers persist in the database even after webhook or token settings are removed. Preserve them during migration and restoration; do not edit them to bypass access checks.
- PostgreSQL is mandatory. Schema migration or database connection failure stops startup; the app has no JSON or in-memory production fallback. Use a direct database endpoint or session-mode pooler for its dedicated `LISTEN` connection.
- Legacy `events.json` files and database dumps remain sensitive after migration. The importer does not delete its source. Keep those files outside the static web root and out of Git, and protect retained copies.
- The application does not configure your reverse proxy or trust forwarded client IP headers. Request and SSE limits apply per process; use gateway controls when you need limits shared across replicas.

See [configuration.md](docs/configuration.md) for setup, migrations, limits, and recovery. `.env` and the legacy `.data/` directory are ignored by Git, but custom backup and data paths also need to be excluded. The app retains normalized events and accepted delivery IDs without automatic expiry; it does not retain raw webhook payloads.
