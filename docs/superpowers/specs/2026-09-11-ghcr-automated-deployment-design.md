# GHCR Automated Production Deployment Design

## Summary

ship.live will build its production container on GitHub-hosted Actions, publish the verified image to GitHub Container Registry (GHCR), and deploy that exact immutable image to the existing GCP host only when a GitHub Release with a valid version tag is published. Pushes to `main` and pull requests continue to run CI but never publish an image or touch production. The production host will pull images instead of compiling TypeScript and Vite locally.

The deployment path is deliberately narrow: GitHub Actions can invoke only a root-owned ship.live deployment command through a forced SSH key. It cannot obtain a general interactive shell on the host.

## Goals

- Build the production image automatically when a GitHub Release with a stable version tag is published.
- Run all existing CI gates before publishing or deploying.
- Smoke-test the same image artifact that will be published.
- Publish an immutable commit tag and deploy by registry digest.
- Keep production secrets exclusively in `.env.production` and the mounted certificate on the GCP host.
- Serialize production deployments and prevent overlapping release deployments.
- Verify Docker health and the public HTTPS health endpoint before reporting success.
- Restore the last healthy image automatically when it is schema-compatible.
- Remove Node dependency installation and application compilation from the production host.

## Non-goals

- Building ARM images; the current GCP production host is the only deployment target.
- Replacing Caddy, PostgreSQL/Supabase, or the existing application health endpoint.
- Running a self-hosted GitHub Actions runner on production.
- Introducing Kubernetes, Watchtower, or another deployment control plane.
- Copying `.env.production`, database credentials, GitHub credentials, or TLS material into the image or Actions artifacts.

## Selected Architecture

The existing CI workflow remains the gate for pushes and pull requests. A published GitHub Release triggers the read-only `Release` signal workflow, which uploads only a bounded stable tag record and executes no repository code. A separate `Release publish` workflow uses `workflow_run` and is loaded from the default branch. It requires a successful release-origin run, validates the exact-run artifact, binds its canonical tag SHA to the triggering run SHA, verifies main ancestry and the current published non-draft/non-prerelease Release API record, and only then runs policy code from the trusted workflow revision. It checks out the validated release SHA for format/PostgreSQL/build, browser, and runtime-image gates, then publishes and deploys only if every gate succeeds. The reviewed push/PR workflows receive no package write permission or production environment access.

Repository writers are trusted principals: GitHub allows them to replace a workflow and request broader `GITHUB_TOKEN` permissions. This design isolates the reviewed privileged consumer and rejects accidental/unmerged release signals; it cannot sandbox a malicious repository writer. Governance must restrict write/release authority, protect `main` with review and CI, restrict the production environment to protected branches, and audit workflow and release-policy changes.

Production releases use stable SemVer tags matching `v<major>.<minor>.<patch>`, for example `v1.4.2`. Draft releases do not trigger the workflow, and prerelease tags such as `v1.4.2-rc.1` are rejected by the production workflow. Before building, the workflow verifies that the tag resolves to the release target commit and that the commit is an ancestor of `origin/main`; a release cannot deploy an arbitrary unmerged revision.

The deployment job uses a GitHub `production` environment and a `production` concurrency group. It connects with native OpenSSH to a dedicated forced-command key on the GCP host and requests deployment of exactly `ghcr.io/vndee/ship.live@sha256:<digest>`. The host-side command validates that reference, pulls it, recreates the app, waits for health, checks the public endpoint, and records the digest as the last healthy release.

The environment uses `deployment: false` to suppress the automatic deployment record at the consumer's current-main SHA. The job explicitly creates and verifies a deployment at the validated release SHA with the digest and tag in its payload, then records `in_progress` and the attempt's terminal status. Required reviewers, branch restrictions, secrets, and wait timers remain; custom deployment protection-rule apps are incompatible with this mode and must be checked before rollout.

GitHub documents `GITHUB_TOKEN` with `packages: write` as the standard GHCR publishing mechanism. GitHub environments scope deployment secrets and create deployment history, while concurrency limits production to one active deployment. References:

- <https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images>
- <https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments>
- <https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility>

## Container Artifact Contract

The canonical package is `ghcr.io/vndee/ship.live`.

Every release image has:

- immutable version tag matching the GitHub Release tag, such as `v1.4.2`;
- immutable tag `sha-<40 lowercase hexadecimal commit SHA>`;
- OCI source label pointing to `https://github.com/vndee/ship.live`;
- OCI revision label containing the full commit SHA;
- a ship.live schema-version label equal to the highest numbered SQL migration included in the image;
- `io.ship-live.max-schema-version` declaring the maximum schema the image supports;
- `io.ship-live.tested-predecessor` containing the exact immutable `ghcr.io/vndee/ship.live@sha256:<64 lowercase hex>` image exercised by the compatibility gate, or the literal `none` for first-release bootstrap;
- the existing Docker healthcheck against `http://127.0.0.1:3001/api/health`.

The workflow deploys the returned registry digest, not either tag. Version and commit tags are treated as immutable: the workflow fails if the version tag already exists with a different digest. Production state and rollback state never depend on a mutable registry tag.

The GHCR package is public because the repository and application source are public and the image contains no runtime secrets. Public GHCR packages support anonymous pulls, avoiding a long-lived registry credential on production. The first publish is a bootstrap phase: publish without deploying, change the package visibility to public, verify an anonymous manifest pull, and only then enable automatic deployment.

## Build and Publish Flow

1. A pull request or push starts the existing CI jobs; these runs never publish or deploy.
2. Publishing a non-draft GitHub Release starts the read-only signal from the release tag, followed by the trusted default-branch `workflow_run` consumer.
3. The consumer validates source-run provenance, the bounded exact-run tag artifact, canonical tag/SHA binding, main ancestry, current Release API state, and tagged package version before release-controlled execution.
4. The release workflow reruns the required format/PostgreSQL/build and browser gates against the tagged revision.
5. Before building, the job resolves the greatest lower stable tag's published GHCR manifest to an immutable digest and checks that image's source, version, revision, platform, and schema labels. An unpublished predecessor or registry error fails closed. It builds the current `runtime` target once for `linux/amd64`, embedding that exact tested-predecessor digest. No previous source rebuild substitutes for the published image.
6. The job runs the existing digest-module smoke test against that prebuilt image. The test no longer performs a second internal build when an image reference is supplied.
7. The exact previous digest seeds an isolated database, the current image migrates it, and the same previous digest must pass representative store reads, writes, updates, protection, and deduplication. Only after every gate succeeds does the publishing job authenticate to GHCR, copy the tested bytes under version and commit tags with digest preservation, and verify the remote digest plus version, revision, and tested-predecessor labels. First release emits `none` only with deployment disabled and no previous tag/revision.
8. The production job sends only the immutable digest reference to the forced SSH command.

All third-party Actions are pinned to full commit SHAs. Permissions default to `contents: read`; only the trusted publishing job requests `packages: write`, validation requests `actions: read`, and deployment requests `deployments: write`. Only deployment accesses the production environment and its secrets. These are permissions of the reviewed workflows, subject to the repository-writer trust assumption above.

## Production Compose Contract

`compose.external.yml` becomes a tracked, reproducible production definition. Its app service changes from a local build to:

```yaml
image: ${APP_IMAGE:?Set APP_IMAGE to an immutable GHCR digest}
```

The `build:` block is removed. Existing environment, read-only filesystem, temporary filesystem, certificate mount, private network, Caddy ports, volumes, and health dependency remain unchanged.

The deployment command always supplies `APP_IMAGE` from its validated digest. Direct production operations use the same root-owned wrapper, which reads the recorded last healthy digest; operators do not run bare `docker-compose up` without an image reference.

Because the server currently has an untracked `compose.external.yml`, bootstrap preserves a timestamped root-readable backup, installs the tracked version, renders `docker-compose config` without printing it to logs, and verifies that the only material app change is the image source.

## Restricted SSH Boundary

Bootstrap creates one Ed25519 key pair dedicated to ship.live deployment. The public key entry in the deploy user's `authorized_keys` includes:

- a forced root-owned deployment command;
- `no-agent-forwarding`;
- `no-port-forwarding`;
- `no-X11-forwarding`;
- `no-pty`;
- source-address restriction when GitHub-hosted runner addressing can be enforced without making deployments unreliable.

The private key is stored only as a `production` environment secret. The host key is pinned in another environment secret; the workflow never uses `StrictHostKeyChecking=no` or opportunistic `ssh-keyscan` at deploy time. Host and user values are environment variables, not secrets, unless the operator chooses to hide them.

The forced command reads `SSH_ORIGINAL_COMMAND` and accepts exactly one argument matching:

```text
ghcr.io/vndee/ship.live@sha256:<64 lowercase hexadecimal characters>
```

It rejects flags, additional arguments, tags, alternate registries, shell metacharacters, and unexpected working directories.

## Deployment Transaction

The root-owned host script performs these steps under an exclusive lock:

1. Validate the requested digest reference.
2. Read the last healthy digest and schema version from root-owned deployment state.
3. Pull the target digest anonymously from GHCR.
4. Validate the target image's source, version, revision, schema range, and tested-predecessor labels. With existing state, reject the `none` sentinel; before any schema increase, require the candidate's tested predecessor to equal durable `current.IMAGE`. With empty state, require `none` and the separately rehearsed bootstrap procedure.
5. Render the Compose model with the target `APP_IMAGE` and validate it before touching the running container. A predecessor mismatch fails before even rendering Compose or starting migrations.
6. Recreate only the app service; keep Caddy running.
7. Wait up to 120 seconds for Docker health to become `healthy`, failing early on a stopped or repeatedly restarting container.
8. Require `https://ship.duy.dev/api/health` to return HTTP 200 with `{"status":"ok"}`.
9. Atomically record the digest, revision, schema version, and deployment time as the last healthy release.
10. Remove unreferenced ship.live images while retaining the current and previous healthy digests.

Logs contain revisions, digests, health states, and bounded application log tails. They never print `.env.production`, rendered Compose environment values, SSH private material, or database URLs.

## Rollback and Database Compatibility

Application startup currently applies pending SQL migrations and refuses to start an image whose known schema is older than the database. Blindly restoring an older image after a migration can therefore fail even when the older container image itself is valid.

The deployment contract adopts expand/contract migrations:

- migrations deployed by this pipeline must remain readable and writable by the immediately previous healthy image;
- destructive column/table removal, renaming, or incompatible constraint changes require a later cleanup release after the old image is no longer a rollback target;
- the database/schema compatibility guard and its tests must represent that one-release rollback window explicitly;
- each image carries its highest migration number so the host can make a rollback decision without reading database credentials.

If deployment health fails and the target schema version equals the previous schema version, the script automatically recreates the previous digest and verifies its Docker and public health.

If the target advances the schema version, its compatibility evidence must name the exact durable pre-attempt `current` image before replacement is allowed. For example, if B was published but skipped or failed deployment and production still runs A, C tested against B cannot migrate production A; the host rejects C before mutation. Same-schema releases may name a different validated predecessor because they introduce no schema migration. A first-release `none` image is accepted only with empty deployment state and the documented legacy-image capture, identical migration-set check, and isolated rollback rehearsal.

After a failed replacement, rollback still requires the pre-attempt current image's max-schema label to cover the target schema. If it does not, the host stops the failed app, leaves Caddy running, preserves both images and logs, and fails for operator intervention. The workflow never claims a successful rollback it has not health-checked. Numeric schema coverage alone does not authorize a schema-changing replacement with untested rollback bytes.

The first implementation includes compatibility for the repository's current additive migrations and automated tests proving the previous release can open the migrated schema. This makes automatic rollback a tested property rather than an assumption.

## Failure Handling

- CI failure: publish and deploy jobs do not run.
- Image smoke-test failure: no image is published.
- GHCR push or digest verification failure: production is untouched.
- Host-key/authentication failure before the command is accepted: production is untouched. SSH disconnect or timeout after acceptance can occur after host commit; a failed attempt does not prove production remained unchanged or rolled back. Reconcile durable state, running digest, and health before retrying.
- Deployment API failure or runner termination: the record may remain `in_progress`, or a terminal status update may fail after the host committed. Reconcile host evidence with the exact-SHA deployment payload before correcting status or retrying; do not infer host state from Actions status alone.
- Concurrent release: at most one production deployment runs. Release deployments queue instead of cancelling an in-progress deployment, and each deployment rechecks that it is not older than the recorded production version before changing the app.
- Pull failure: current container remains running.
- New-container health failure: apply the schema-aware rollback rules above.
- Public health failure after Docker health succeeds: treat the deployment as failed and apply the same rollback rules.
- Rollback failure: preserve diagnostic state, stop retrying, emit the bounded app log tail, and require operator intervention.

## Repository Changes

- `.github/workflows/ci.yml`: preserve push and pull-request CI without publish or deployment permissions.
- `.github/workflows/release.yml`: read-only release-tag signal and bounded artifact upload.
- `.github/workflows/release-publish.yml`: trusted default-branch consumer validation, release gates, immutable publishing, and exact-revision production deployment tracking.
- `deploy/runtime-image.test.mjs`: accept a prebuilt image reference while preserving its standalone local build mode.
- `compose.external.yml`: tracked external-database production Compose definition using immutable `APP_IMAGE`.
- `deploy/ship-live-deploy`: host deployment transaction, lock, health verification, state recording, and rollback.
- `deploy/ship-live-deploy.test.mjs`: controlled fake-Docker tests for validation, success, concurrency, failure, and rollback branches.
- `Dockerfile`: OCI metadata and schema-version labels supplied by build arguments.
- `server/postgres-store.ts` and PostgreSQL tests: encode and verify the one-release expand/contract rollback window.
- `docs/self-host-docker.md`: GHCR deployment, bootstrap, rollback, secret rotation, and manual recovery commands.

## Bootstrap Sequence

The rollout avoids a circular first deployment:

1. Land the release image build/publish portion with deploy disabled.
2. Publish the first versioned GitHub Release and let it publish the first GHCR image without deploying.
3. Set the linked package public and verify anonymous pull access.
4. Install the tracked external Compose definition and root-owned deployment script on GCP.
5. Create the restricted SSH key and pinned host-key secrets in the GitHub `production` environment.
6. Run the deployment script manually once with the published digest and verify health.
7. Land/enable the automatic deployment job.
8. Publish the next versioned GitHub Release, then observe one complete release deployment and one controlled rollback rehearsal.

At each stage, the currently healthy production container remains the fallback until the next image passes health verification.

## Verification

Required automated evidence:

- Existing format, PostgreSQL, build, and browser suites remain green.
- The runtime smoke test fails when a server-required source tree is absent and passes against the prebuilt production image.
- Workflow policy tests show pull requests and ordinary pushes cannot publish or deploy; only a valid published stable release can proceed after every release gate succeeds.
- Release policy tests reject malformed tags, prerelease versions, tag/target mismatches, revisions outside `main`, and attempts to reuse a version tag for a different digest.
- Deployment-script tests cover malformed references, lock contention, pull failure, healthy deployment, Docker health timeout, public health failure, schema-compatible rollback, schema-incompatible failure, and rollback failure.
- Compose configuration validation proves `build:` is absent and `APP_IMAGE` is required.
- PostgreSQL compatibility tests prove the exact published predecessor can operate after the current additive migrations and reject destructive fixtures. Host regressions cover both skipped and failed intermediate releases, proving a mismatched predecessor cannot reach schema-changing replacement.

Required live evidence:

- GHCR exposes the version tag, commit tag, and immutable digest anonymously.
- GitHub records a successful `production` deployment for the exact revision.
- GCP reports `ship-live_app_1` as `healthy` with zero restarts.
- The running container image matches the workflow's digest.
- `https://ship.duy.dev/api/health` returns HTTP 200 and `{"status":"ok"}`.
- A controlled bad-health image restores the prior digest when schema-compatible and marks the workflow failed.

## Success Criteria

- A successful push to `main` runs CI but leaves GHCR and production unchanged.
- Publishing a valid stable GitHub Release reaches healthy production without compiling on GCP.
- A failed CI run, failed image smoke test, or failed publish leaves production unchanged.
- Production runs the exact GHCR digest reported by its GitHub deployment.
- Production deployment access cannot execute arbitrary SSH commands.
- The last healthy release is recoverable without relying on a mutable registry tag.
- Database migrations cannot silently invalidate the advertised rollback path.
