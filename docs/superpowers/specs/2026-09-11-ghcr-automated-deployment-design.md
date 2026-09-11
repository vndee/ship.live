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

The existing CI workflow remains the gate for pushes and pull requests. A published GitHub Release triggers a separate release workflow that checks out the release tag, validates it, reruns the required format/PostgreSQL/build, browser, and runtime-image gates against that exact revision, then publishes and deploys only if every gate succeeds. Normal pushes, including pushes to `main`, receive no package write permission and have no path to the production environment.

Production releases use stable SemVer tags matching `v<major>.<minor>.<patch>`, for example `v1.4.2`. Draft releases do not trigger the workflow, and prerelease tags such as `v1.4.2-rc.1` are rejected by the production workflow. Before building, the workflow verifies that the tag resolves to the release target commit and that the commit is an ancestor of `origin/main`; a release cannot deploy an arbitrary unmerged revision.

The deployment job uses a GitHub `production` environment and a `production` concurrency group. It connects with native OpenSSH to a dedicated forced-command key on the GCP host and requests deployment of exactly `ghcr.io/vndee/ship.live@sha256:<digest>`. The host-side command validates that reference, pulls it, recreates the app, waits for health, checks the public endpoint, and records the digest as the last healthy release.

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
- the existing Docker healthcheck against `http://127.0.0.1:3001/api/health`.

The workflow deploys the returned registry digest, not either tag. Version and commit tags are treated as immutable: the workflow fails if the version tag already exists with a different digest. Production state and rollback state never depend on a mutable registry tag.

The GHCR package is public because the repository and application source are public and the image contains no runtime secrets. Public GHCR packages support anonymous pulls, avoiding a long-lived registry credential on production. The first publish is a bootstrap phase: publish without deploying, change the package visibility to public, verify an anonymous manifest pull, and only then enable automatic deployment.

## Build and Publish Flow

1. A pull request or push starts the existing CI jobs; these runs never publish or deploy.
2. Publishing a non-draft GitHub Release starts the release workflow from the release tag.
3. The workflow requires a tag matching stable SemVer, verifies the tag-to-release commit binding, and verifies that the commit belongs to `main` history.
4. The release workflow reruns the required format/PostgreSQL/build and browser gates against the tagged revision.
5. Its runtime-image job builds the `runtime` target once for `linux/amd64` and tags it locally with the version and commit SHA.
6. The job runs the existing digest-module smoke test against that prebuilt image. The test no longer performs a second internal build when an image reference is supplied.
7. Only after all release gates succeed, the publishing job authenticates to `ghcr.io` with `GITHUB_TOKEN`, pushes the version and commit tags, resolves the registry digest, and verifies that the pushed manifest contains the expected version and commit labels.
8. The production job sends only the immutable digest reference to the forced SSH command.

All third-party Actions are pinned to full commit SHAs. Job-level permissions default to `contents: read`; only the release publishing job receives `packages: write`. Only the release deployment job can access the GitHub `production` environment and its secrets. Pull-request and ordinary push code cannot access package-write or production credentials.

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
4. Read and validate the target image's OCI revision and ship.live schema-version labels.
5. Render the Compose model with the target `APP_IMAGE` and validate it before touching the running container.
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

If the target advances the schema version, the script attempts rollback only when the image labels declare the previous revision compatible with that schema. Without that declaration it stops the failed app, leaves Caddy running, preserves both images and logs, and fails the Actions deployment for operator intervention. The workflow never claims a successful rollback it has not health-checked.

The first implementation includes compatibility for the repository's current additive migrations and automated tests proving the previous release can open the migrated schema. This makes automatic rollback a tested property rather than an assumption.

## Failure Handling

- CI failure: publish and deploy jobs do not run.
- Image smoke-test failure: no image is published.
- GHCR push or digest verification failure: production is untouched.
- SSH or host-key failure: production is untouched and the deployment fails.
- Concurrent release: at most one production deployment runs. Release deployments queue instead of cancelling an in-progress deployment, and each deployment rechecks that it is not older than the recorded production version before changing the app.
- Pull failure: current container remains running.
- New-container health failure: apply the schema-aware rollback rules above.
- Public health failure after Docker health succeeds: treat the deployment as failed and apply the same rollback rules.
- Rollback failure: preserve diagnostic state, stop retrying, emit the bounded app log tail, and require operator intervention.

## Repository Changes

- `.github/workflows/ci.yml`: preserve push and pull-request CI without publish or deployment permissions.
- `.github/workflows/release.yml`: release-tag validation, repeated release gates, immutable image publishing, and production deployment with least-privilege permissions.
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
- PostgreSQL compatibility tests prove the immediately previous application schema can operate after the current additive migrations.

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
