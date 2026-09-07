# Security

ship.live is an early self-hosted application. Security fixes target the latest code on `main`; there is no supported long-term release branch yet.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/vndee/ship.live/security/advisories/new) when it is enabled. If the private report form is unavailable, contact the maintainer through the contact methods on [their GitHub profile](https://github.com/vndee) to arrange a private channel before sharing details. Do not put an exploit, credentials, or private organization data in a public issue.

Include the affected version or commit, reproduction steps with synthetic data, the impact, and any proposed fix. Remove access keys, GitHub tokens, webhook secrets, and private payloads from attachments.

## Deployment assumptions

- Keep GitHub tokens and webhook secrets on the server. Never put them in `VITE_*` variables or frontend source.
- Use different random values for `GITHUB_WEBHOOK_SECRET` and `DASHBOARD_ACCESS_KEY`. Deliver webhooks and serve dashboards over HTTPS.
- A dashboard key is shared access for a trusted team, not individual authentication. Put private instances behind your organization's access controls.
- Activity in `DATA_DIR` can contain private titles, repository names, and contributor information. Keep it outside the static web root and protect backups.
- The bounded JSON store assumes one Node process. Do not share its file between multiple replicas.
- The application does not configure your reverse proxy or trust forwarded client IP headers. Review rate limits and proxy behavior for your deployment.

See [configuration.md](docs/configuration.md) for the supported setup and limits. `.env` and the default `.data/` directory are ignored by Git, but custom data directories also need to be excluded.
