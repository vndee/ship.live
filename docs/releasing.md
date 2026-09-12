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
   Review every SQL change for expand/contract compatibility: the immediately
   previous release must still read and write the migrated schema. Add fields
   compatibly first; remove/rename columns, tables, or incompatible constraints
   only in a later cleanup release after the affected image leaves the rollback
   window. Keep the previous-image operational probe representative of any
   changed store operations; a schema-range label alone is not proof.
4. Create annotated tag `vX.Y.Z` on that exact `main` commit.
5. Publish a non-prerelease GitHub Release.
6. Follow both linked Actions runs: `Release` records the tag, then `Release publish` performs validation, gates, image smoke and compatibility, publication, and production health. Find the follow-up run in Actions; its triggering workflow run links back to `Release`.

The reviewed `Release` workflow (`.github/workflows/release.yml`) runs from the
release tag with only `contents: read`. It uploads one bounded tag record and
does not check out source, publish images, or access production secrets. Its
successful completion signals `Release publish`
(`.github/workflows/release-publish.yml`) through `workflow_run`. GitHub loads
that consumer from the default branch; both workflows must be present on
protected `main` before relying on this release path.

The consumer treats the signal and artifact as hostile. It requires a successful
source run whose event is `release`, downloads the artifact from that exact run,
and accepts only one stable SemVer record of at most 128 bytes, including its
newline. It binds the canonical tag commit to the triggering run's `head_sha`,
requires that commit and the trusted workflow revision to belong to `main`,
and queries the current Release API record to require the same tag, a published
date, `draft: false`, and `prerelease: false`. Only then does it execute policy
code from its trusted workflow revision. It reads the tagged `package.json`
as JSON with `git show`, verifies the version match, and subsequently checks
out the validated release SHA. An unmerged tag or forged signal cannot obtain
this consumer's publication outputs or run its replaced validator. It then runs format, deployment
policy, PostgreSQL, build, browser, image smoke, and previous-release schema
compatibility gates. Before building the candidate, the workflow resolves the
greatest lower stable tag's published GHCR digest and validates its version,
revision, platform, source, and schema range. Missing predecessor publication
fails closed. That exact digest seeds representative events, the new
image applies migrations to an isolated synthetic database, and the previous
store performs real inserts, updates, reads, listing, protection, and delivery
deduplication before publication. The image is built once, labelled with the version,
revision, schema range, and `io.ship-live.tested-predecessor` digest, copied with Skopeo under both `vX.Y.Z` and
`sha-<40-character-commit>` immutable tags, and rechecked by digest before it
can be handed to deployment.

Before a schema increase, the host requires that tested predecessor digest to
equal durable `current.IMAGE`. If an intermediate release was skipped or failed,
deploy and verify that predecessor first, or prepare a newly reviewed release
whose compatibility evidence covers the actual current image. Do not relabel
an existing image or edit deployment state to bypass the check. Same-schema
releases can proceed with a different predecessor. The first stable release
uses the literal `none`, requires deployment disabled during publication, and
is accepted only with empty host state and the documented bootstrap rehearsal.

The deployment job retains the `production` environment gate and secrets, but
uses `deployment: false` to suppress GitHub's automatic record for the consumer's
current-main SHA. After the anonymous image check, it creates an explicit
deployment whose `ref` is the validated release SHA and whose payload contains
the exact image digest and release tag. Automatic merging is disabled, and the
workflow's completed release gates supply validation instead of API commit-status
contexts. The job verifies the returned record before SSH, records `in_progress`,
and records `success` only after the host command exits successfully; unsuccessful
attempts record `failure`. Only this job receives `deployments: write`.
See GitHub's [environment tracking controls](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments#using-environments-without-deployments),
[deployment creation API](https://docs.github.com/en/rest/deployments/deployments#create-a-deployment),
and [deployment status API](https://docs.github.com/en/rest/deployments/statuses#create-a-deployment-status).

If the final status API call fails or the runner is forcibly terminated, the
record can remain `in_progress` even when the host changed. Treat the attempt as
unresolved: compare the host's recorded digest and health with the deployment
payload before correcting status or retrying. An SSH failure may also occur
after a host commit; `failure` describes the attempt, not proof of host rollback.

Repository writers remain trusted. GitHub lets a writer replace a workflow and
request broader `GITHUB_TOKEN` permissions; the reviewed signal's read-only
declaration is not an enforced ceiling for another writer-authored workflow.
This split protects the reviewed consumer's validation boundary, and does not
sandbox a malicious writer or prevent them publishing through a different
workflow. Before enabling automation, restrict repository write and release
authority to trusted maintainers, protect `main` with required reviews and CI,
restrict the `production` environment to protected branches, and audit changes
to workflows and release policy. Keep production secrets exclusively in that
environment. Before enabling this path, confirm that `production` has no custom
deployment protection-rule app: those apps require automatic deployment objects
and are incompatible with `deployment: false`. Required reviewers, wait timers,
and branch restrictions still apply. If a custom protection app is required,
keep this path disabled pending a compatible design rather than removing the
control to make the workflow run. Preventing a malicious writer from publishing packages would
require an external registry authority or an additional human authorization
boundary beyond this automatic repository workflow.

Pushing a tag alone, saving a draft, publishing a prerelease, or pushing
`main` does not deploy. A published stable Release publishes an image, but the
managed deployment job runs only when the repository variable
`PRODUCTION_DEPLOY_ENABLED` is exactly `true`; trusted consumer runs are serialized by
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
