# Contributing to ship.live

Small, focused contributions are welcome: bug fixes, accessibility improvements, better documentation, and clearer ways to explore engineering activity. For a substantial change, open an issue describing the problem and proposed behavior first.

## Local setup

Fork the repository, clone your fork, and use Node.js 22.12+ (`nvm use` selects the version in `.nvmrc`).

```sh
npm ci
npm run dev
```

The frontend runs at `http://localhost:5173` and proxies `/api` to port 3001. Demo mode needs no credentials. Optional server settings are documented in [configuration.md](docs/configuration.md).

## Before a pull request

```sh
npm run format:check
npm test
npm run build
```

Use `npm run format` to apply formatting. Add meaningful tests when behavior changes; cover the original failure for bug fixes. Check affected interactions at desktop and mobile widths, and fullscreen when changing layout. Preserve keyboard navigation, focus handling, reduced motion, and the distinction between demo and connected data.

Describe the problem, resulting behavior, and validation in your pull request. Include before/after screenshots for visible changes, using demo data. Keep unrelated refactoring separate so the change is easy to review.

## Project conventions

- Keep organization configuration in environment variables. Never commit `.env`, tokens, webhook secrets, private activity, or stored payloads.
- Use fictional actors and generic organization names in fixtures and screenshots.
- `shared/types.ts` defines the normalized event contract. New event types need normalization, recognition semantics, UI labels, and relevant tests.
- Credit useful outcomes and collaboration. Raw commit volume should not increase scores.
- Prefer the existing toolchain and small dependencies with a clear purpose.

See [architecture.md](docs/architecture.md) for how the frontend and server fit together.

## Reporting issues

Include steps to reproduce, expected and actual behavior, browser/OS, and whether the issue occurs in demo or connected mode. Remove repository names or other private details before attaching screenshots and logs.

For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue. Keep discussion specific and respectful; critique the work and give contributors room to explain their reasoning.
