# Preparing the initial GitHub release

Target repository: **`vndee/ship.live`**. The steps below are a maintainer handoff; creating the public repository and pushing the code are separate from preparing this local checkout.

## Before publishing

- Choose a license, add `LICENSE`, and update the license fields in `package.json`, `package-lock.json`, and the README.
- Review the staged file list. Keep `.env`, `.data`, dependencies, build outputs, and local artifacts out of Git. Exclude any custom `DATA_DIR` as well.
- Run `npm ci`, `npm run format:check`, `npm test`, and `npm run build`.
- Smoke-test `npm start` with a fresh data directory and synthetic configuration. Confirm `/api/health` and the built interface respond.
- Review the [showcase images](showcase.md) and the [configuration guide](configuration.md).

## Repository details

- **Name:** `ship.live`
- **Description:** Work, in orbit. A self-hosted GitHub activity wall with interactive visualization and shared team milestones.
- **Topics:** `github`, `github-webhooks`, `engineering`, `developer-tools`, `data-visualization`, `self-hosted`, `react`, `typescript`
- **Default branch:** `main`
- **Website:** Leave blank until a public demo or project site exists. The product name does not imply ownership of the matching domain.

## Publish after the release is approved

Create an empty public `vndee/ship.live` repository. Do not generate an extra README, license, or `.gitignore` on GitHub; those belong in the reviewed local commit.

If the local checkout has no remote yet:

```sh
git remote add origin https://github.com/vndee/ship.live.git
```

Push the reviewed history:

```sh
git push -u origin main
```

After the first push, verify the README images render and the CI workflow passes. Enable GitHub private vulnerability reporting before relying on the private reporting link in `SECURITY.md`.

Once CI is green, update the unreleased changelog date, tag the chosen release, and prepare GitHub release notes from [CHANGELOG.md](../CHANGELOG.md). Do not advertise the project as open source before its license is in place.
