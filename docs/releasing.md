# Preparing a release

The project repository is [`vndee/ship.live`](https://github.com/vndee/ship.live). These steps prepare and verify a reviewed release; database deployment remains the responsibility of the host operator.

## Before publishing

- Keep the [MIT License](../LICENSE) and package metadata consistent. Preserve the third-party notices in `public/licenses/`; Vite copies them to production builds.
- Review the staged file list. Keep `.env`, legacy `.data` files, database dumps and backups, dependencies, build outputs, and local artifacts out of Git. Exclude custom paths containing sensitive data too.
- Run `npm ci`, `npm run format:check`, `npm run test:db`, and `npm run build`. Supply `TEST_DATABASE_URL` for a dedicated PostgreSQL test server whose role can create isolated databases; see the [test setup](configuration.md#database-tests). A run with skipped database tests is not sufficient release validation.
- Smoke-test `npm start` with an isolated PostgreSQL database. Confirm `/api/health` and the built interface respond, startup applies migrations, private routes require an authenticated session, and the former organization/key API routes return `404`. Use synthetic provider fixtures for automated tests; also verify real Google/GitHub sign-in and GitHub App consent in a separately configured staging environment before a production rollout.
- For persistence or streaming changes, verify two app instances sharing that database: a webhook accepted by one must reach an authorized viewer on the other, and duplicate deliveries must not create duplicate activity.
- Review the [showcase images](showcase.md), [configuration guide](configuration.md), and upgrade notes in [CHANGELOG.md](../CHANGELOG.md).

## PostgreSQL upgrade and deployment

`DATABASE_URL` is required. Local Compose is a development convenience; the repository does not provision a remote database or choose a hosting provider. Use a direct database endpoint or a session-mode pooler for the dedicated PostgreSQL `LISTEN` connection.

For deployments upgrading from JSON storage:

1. Stop the old writer and back up its `events.json` file.
2. Configure the new PostgreSQL connection and run `npm run db:import-json -- /path/to/events.json`.
3. Retain the imported data for recovery. Legacy organization records are not automatically assigned to a new account or installation, and the old token/dashboard-key routes are no longer mounted. Configure Supabase Auth and the GitHub App, sign in, connect selected repositories, and verify the new private workspace before directing traffic to it.

The importer leaves the source untouched. It validates the complete file and imports data in one transaction; schema setup runs separately. `DATA_DIR` is no longer read, and there is no JSON fallback. See [the upgrade guide](configuration.md#upgrading-an-existing-installation) for access and migration details.

For later deployments, take a database backup and review SQL migrations before rollout. Startup applies them automatically under an advisory lock; `npm run db:migrate` can apply them explicitly beforehand. Do not assume an older application version can use a newer schema. Check readiness and database connectivity after rollout, and test restoration as part of the hosting procedure.

Replicas must use the same database, Supabase project, GitHub App credentials, `APP_URL`, and `TOKEN_ENCRYPTION_KEY`. Changing the encryption key requires a deliberate migration or reconnect procedure; do not replace it casually. Repository access is checked per signed-in viewer. Verify that disconnect, logout, and permission revocation remove private data across instances. Request limits are shared through PostgreSQL; if it is unreachable, each process falls back to its own counts, so replicas together can briefly allow more than the limit. Live-stream limits remain per process.

For Supabase-hosted PostgreSQL, verify application tables have RLS enabled and no grants to `PUBLIC`, `anon`, or `authenticated`; disable the unused Data API. Use a direct connection or the session pooler, not transaction pooling. See [Railway deployment](railway.md) for hosting settings and free-plan limits.

## Repository details

- **Name:** `ship.live`
- **Description:** Work, in orbit. Private ship journals and GitHub activity for individual builders and teams.
- **Topics:** `github`, `github-webhooks`, `engineering`, `developer-tools`, `data-visualization`, `self-hosted`, `react`, `typescript`
- **Default branch:** `main`
- **Website:** Leave blank until a public demo or project site exists. The product name does not imply ownership of the matching domain.

## Publish a stable release

The public repository and a normal self-hosted installation do not need access
to the managed `vndee/ship.live` production environment. The following is the
release path for this repository. It builds and publishes an immutable GHCR
image, and can deploy only the managed ship.live service when its separately
configured production gate is enabled. For a general local self-host update,
use [the Docker self-host guide](self-host-docker.md) instead.

Follow this exact operator sequence:

1. Update `package.json` and `package-lock.json` to `X.Y.Z`.
2. Move `CHANGELOG.md` entries into the dated release.
3. Merge and wait for CI on `main`.
4. Create annotated tag `vX.Y.Z` on that exact `main` commit.
5. Publish a non-prerelease GitHub Release.
6. Follow the release workflow through validate, gates, publish, compatibility, and production health.

The release workflow accepts only a published, non-draft, non-prerelease
stable tag whose version matches `package.json`, resolves to the release event
commit, and is already in `main` history. It then runs format, deployment
policy, PostgreSQL, build, browser, image smoke, and previous-release schema
compatibility gates. The image is built once, labelled with the version,
revision, and schema range, copied with Skopeo under both `vX.Y.Z` and
`sha-<40-character-commit>` immutable tags, and rechecked by digest before it
can be handed to deployment.

Pushing a tag alone, saving a draft, publishing a prerelease, or pushing
`main` does not deploy. A published stable Release publishes an image, but the
managed deployment job runs only when the repository variable
`PRODUCTION_DEPLOY_ENABLED` is exactly `true`; release jobs are serialized by
the `production` concurrency group. The first stable release must be
bootstrapped with that flag disabled because there is no previous release to
prove schema rollback compatibility.

Before relying on the managed path, follow the host and GitHub bootstrap in
[Managed ship.live production operations](self-host-docker.md#managed-shiplive-production-operations).
Verify the README images render and retain GitHub private vulnerability
reporting before relying on the private reporting link in `SECURITY.md`.

## Recover a partially published immutable image

If copying `vX.Y.Z` succeeded but copying `sha-<revision>` failed, treat the
successful version tag as immutable. The workflow does not guarantee that its
in-memory expected digest is persisted before the second copy, so derive the
original digest from the immutable published `vX.Y.Z` tag. Do not delete or
repoint that tag, and do not rerun a rebuild hoping it will produce the same
bytes: a changed digest is a different release and must not be substituted for
the tested one.

With an authenticated GHCR credential that can write this package, prove that
the version tag exists, derive its digest, verify its release labels, and copy
that exact digest to the missing SHA tag. A missing version tag, invalid
manifest, or label mismatch is a conflict: stop and investigate rather than
copying or rebuilding anything.

```sh
set -euo pipefail
IMAGE_REPOSITORY=ghcr.io/vndee/ship.live
VERSION=vX.Y.Z
REVISION=<40-character-commit>
AUTHFILE="${DOCKER_CONFIG:-$HOME/.docker}/config.json"

skopeo inspect --authfile "$AUTHFILE" --raw \
  "docker://$IMAGE_REPOSITORY:$VERSION" > version-manifest.json
EXPECTED_DIGEST="$(skopeo manifest-digest version-manifest.json)"
[[ "$EXPECTED_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]
skopeo inspect --authfile "$AUTHFILE" --config \
  "docker://$IMAGE_REPOSITORY@$EXPECTED_DIGEST" | jq -e \
  --arg version "$VERSION" --arg revision "$REVISION" '
  .architecture == "amd64" and .os == "linux" and
  .config.Labels["org.opencontainers.image.source"] == "https://github.com/vndee/ship.live" and
  .config.Labels["org.opencontainers.image.version"] == $version and
  .config.Labels["org.opencontainers.image.revision"] == $revision'
if skopeo inspect --authfile "$AUTHFILE" --raw \
  "docker://$IMAGE_REPOSITORY:sha-$REVISION" > existing-sha-manifest.json 2> sha-tag-error; then
  test "$(skopeo manifest-digest existing-sha-manifest.json)" = "$EXPECTED_DIGEST"
elif ! grep -Eq 'MANIFEST_UNKNOWN|NAME_UNKNOWN|manifest unknown|name unknown' sha-tag-error; then
  echo 'Could not establish whether the immutable SHA tag exists.' >&2
  exit 1
fi
skopeo copy --preserve-digests --authfile "$AUTHFILE" \
  "docker://$IMAGE_REPOSITORY@$EXPECTED_DIGEST" \
  "docker://$IMAGE_REPOSITORY:sha-$REVISION"
skopeo inspect --authfile "$AUTHFILE" --raw \
  "docker://$IMAGE_REPOSITORY:sha-$REVISION" > sha-manifest.json
test "$(skopeo manifest-digest sha-manifest.json)" = "$EXPECTED_DIGEST"
```

The command derives `EXPECTED_DIGEST` only from the published version tag and
copies only when `sha-$REVISION` is absent or already resolves to that digest.
A missing or mismatched version tag, or a different SHA-tag digest, is an
immutable-tag conflict and needs investigation. Once both tags and labels
verify, either leave production unchanged or have an authorized
managed-production operator perform the explicit manual digest deployment
documented below. A failed publish never authorizes deployment of unverified
bytes.
