# Security

Security fixes target the latest code on `main`; there is no supported long-term release branch yet. ship.live handles private repository metadata and personal notes, so authentication and repository scope are part of its core API contract.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/vndee/ship.live/security/advisories/new). If unavailable, arrange a private channel through the contact methods on [the maintainer's profile](https://github.com/vndee) before sharing details. Do not publish exploits, credentials, or private user/repository data in an issue.

Include the affected commit, synthetic reproduction steps, impact, and any proposed fix. Remove tokens, cookies, authorization codes, connection strings, private payloads, and repository details from logs and attachments.

## Authentication and access boundaries

- Google/GitHub login is handled by Supabase Auth with a browser-bound PKCE flow. The backend verifies the user; it does not trust a client-supplied user ID or a cookie's embedded user profile.
- Supabase automatically links matching-email OAuth identities under its identity-linking rules. ship.live uses the resulting Supabase UUID. It does not claim this automatic behavior is disabled. [Supabase identity linking](https://supabase.com/docs/guides/auth/auth-identity-linking).
- Supabase session cookies and an additional opaque app session cookie are HttpOnly, host-only, SameSite Lax, and Secure on HTTPS. Only the opaque session's hash is stored in PostgreSQL. Local logout removes that shared session so remaining Supabase JWT lifetime cannot recreate access through the app.
- Mutations require the exact configured Origin and a session-bound CSRF token. Login and GitHub connection callbacks use short-lived, single-use browser/session bindings. Provider tokens and private event data are not stored in browser localStorage.
- Personal notes are owner-only. Private GitHub events require a separate GitHub App connection and the current viewer's repository permissions. Organization membership, an installation callback ID, or an App installation token alone does not authorize a viewer.
- Repository IDs are filtered before feed limits and aggregate metrics. Asynchronous responses and SSE emissions recheck access. Authorization failures do not use cached private results as a fallback.
- The old public-organization/shared-dashboard-key API is not mounted by the current runtime. Legacy stored events are not automatically claimed by a matching organization name or first login.

## GitHub credentials and ingestion

Use a dedicated GitHub App with only the documented read permissions and selected repositories. The GitHub OAuth App configured in Supabase is a separate login integration. Supabase login-provider tokens are discarded; GitHub App data-access tokens are encrypted in PostgreSQL with AES-GCM and a server-managed key. Refresh rotation is coordinated across app processes.

Keep `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`, `TOKEN_ENCRYPTION_KEY`, and `DATABASE_URL` server-only. Never put them in `VITE_*`, frontend source, screenshots, or Git. The Supabase login client needs only a publishable/anon key; secret/service-role keys are rejected. Use separate random encryption and webhook secrets and preserve the encryption key securely when restoring the database.

Webhooks are authenticated by HMAC over their raw bytes, checked against installation/repository scope, normalized, and deduplicated. Lifecycle events invalidate revoked user authorization, removed/suspended installations, and changed repository selections. The app reads activity metadata and does not clone repositories or download source files. Contents-read permission is broader at GitHub's API level, so limiting selected repositories remains useful.

## Database and hosting assumptions

- All application data access goes through Express. Application tables have RLS enabled and grants to `PUBLIC`, `anon`, and `authenticated` revoked. There are no client Data API policies. Disable Supabase's unused Data API as an additional protection. [Supabase Data API security](https://supabase.com/docs/guides/api/securing-your-api).
- The backend's database owner role can bypass RLS. Application scope checks remain essential; RLS is not an isolation boundary against trusted operators or another service given owner credentials.
- Notes and event titles are not end-to-end encrypted. Database operators and anyone controlling the server, encryption key, or backups are trusted. Restrict access, protect storage/backups, and retain provider-recommended TLS certificate verification.
- Serve frontend and API from the exact `APP_URL` origin over HTTPS. Configure proxy/CDN behavior to avoid caching authenticated responses or `Set-Cookie` headers. Do not broaden OAuth redirects to arbitrary preview hosts or trust arbitrary forwarded-host values.
- Each process needs a PostgreSQL query pool and persistent `LISTEN` session. Use a direct or session-mode endpoint, not a transaction pooler. Database/migration failure stops startup; there is no local production fallback.
- Replicas must share consistent Auth, App, public-origin, and encryption settings. Request counters and concurrent-stream limits are process-local; use gateway controls for shared limits.
- Use separate projects, databases, and credentials for tests/previews. Do not provide production secrets to untrusted fork builds. Keep dependencies and the runtime updated and test upgrades before deployment.

Stored events and delivery IDs do not expire automatically. Plan retention, deletion, and tested backups for your installation. A persistent disk is not a backup, and free hosting quotas or project pausing can interrupt availability. Legacy JSON imports preserve their source file; old files/dumps remain sensitive and must stay outside Git and the static web root.

Automated tests cover synthetic authorization, revocation, and isolation scenarios. They are not a security certification or a substitute for validating your actual OAuth settings, deployment, repository permissions, and operational access. See [configuration](docs/configuration.md) and [Railway deployment](docs/railway.md).
