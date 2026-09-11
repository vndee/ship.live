# Release-Triggered GHCR Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, publish, and automatically deploy the exact ship.live production image only when a stable versioned GitHub Release is published.

**Architecture:** Pull requests and ordinary pushes retain a read-only CI workflow. A separate release workflow validates a stable SemVer tag on `main`, reruns all gates, builds and smoke-tests one `linux/amd64` image, publishes immutable version/SHA tags to public GHCR, and sends only its digest to a forced-command SSH key. A root-owned host script serializes deployment, validates image labels, recreates only the app, records healthy state, and performs a health-checked rollback only when the previous image declares the migrated schema compatible.

**Tech Stack:** GitHub Actions, GHCR, Docker Buildx, Docker Compose v1 on GCP, POSIX shell, Node.js test runner, TypeScript, PostgreSQL 18, OpenSSH, Caddy.

**Spec:** `docs/superpowers/specs/2026-09-11-ghcr-automated-deployment-design.md`

## Global Constraints

- Production releases must use stable tags matching `^v[0-9]+\.[0-9]+\.[0-9]+$`; drafts and prereleases never deploy.
- The release tag must resolve to the release target commit, belong to `origin/main` history, and match `package.json` version after removing the leading `v`.
- Pull requests and ordinary pushes receive neither `packages: write` nor production environment secrets.
- Publish immutable `vX.Y.Z` and `sha-<40 lowercase hexadecimal SHA>` tags; deploy only `ghcr.io/vndee/ship.live@sha256:<64 lowercase hexadecimal digest>`.
- The package must be public before automatic deployment so production needs no long-lived registry credential.
- Production secrets remain only in `/opt/apps/ship-live/.env.production` and `/opt/apps/ship-live/secrets/`; neither Actions artifacts nor images contain them.
- SSH deployment access is a forced command with no PTY, forwarding, or interactive shell.
- Deployments serialize, never downgrade the recorded production version, and retain current and previous healthy digests.
- Rollback is permitted only when the previous image's `io.ship-live.max-schema-version` is at least the failed target's `io.ship-live.schema-version`.
- All third-party Actions are pinned to full commit SHAs.
- No production code is written before its focused test has failed for the expected reason.

## File Map

- Create `server/migrations.ts`: the ordered migration manifest and application schema compatibility constants.
- Modify `server/postgres-store.ts`: load the shared manifest and permit only the declared one-version forward schema window.
- Modify `server/postgres-store.test.ts`: verify current, one-version-forward, and too-new schema behavior.
- Create `deploy/image-metadata.mjs`: print validated version, revision, schema, and max-schema build metadata.
- Create `deploy/image-metadata.test.mjs`: test metadata derivation and invalid inputs.
- Modify `Dockerfile`: write OCI and ship.live labels from required build arguments.
- Modify `deploy/runtime-image.test.mjs`: accept `SHIP_LIVE_TEST_IMAGE`, inspect labels, and avoid rebuilding a supplied image.
- Create `deploy/release-policy.mjs`: validate the release event's tag, package version, target SHA, and `main` ancestry.
- Create `deploy/release-policy.test.mjs`: pure and temporary-git-repository release validation tests.
- Create `compose.external.yml`: external-database production Compose definition requiring an immutable `APP_IMAGE`.
- Create `deploy/compose-external.test.mjs`: validate that Compose cannot build locally and cannot render without a digest.
- Create `deploy/ship-live-deploy`: locked host-side pull, label validation, health verification, state update, cleanup, and rollback transaction.
- Create `deploy/ship-live-deploy-ssh`: unprivileged forced-command adapter that validates `SSH_ORIGINAL_COMMAND` before invoking the root transaction through constrained sudo.
- Create `deploy/ship-live-deploy.test.mjs`: fake-command tests for input validation and every deployment/rollback branch.
- Create `deploy/workflow-policy.test.mjs`: assert workflow triggers, permissions, dependencies, concurrency, pinned actions, and digest-only handoff.
- Modify `.github/workflows/ci.yml`: keep push/PR CI read-only and run deployment policy tests.
- Create `.github/workflows/release.yml`: release validation, gates, image publish, schema compatibility check, and deployment.
- Modify `package.json`: expose focused metadata, policy, deployment, and Compose test commands.
- Modify `docs/releasing.md`: document stable release creation and automated production behavior.
- Modify `docs/self-host-docker.md`: document GHCR operation, host bootstrap, restricted SSH, rollback, and recovery.

---

### Task 1: Make Schema Compatibility an Explicit Application Contract

**Files:**

- Create: `server/migrations.ts`
- Modify: `server/postgres-store.ts:1-125`
- Modify: `server/postgres-store.test.ts:1-130`

**Interfaces:**

- Produces: `MIGRATION_FILES: readonly string[]`, `SCHEMA_VERSION: number`, `MAX_SUPPORTED_SCHEMA_VERSION: number`, and `assertSupportedSchema(appliedVersions: readonly number[]): void`.
- Consumes: SQL files `server/migrations/001_initial.sql` through `server/migrations/018_pulse_heading.sql`.

- [ ] **Step 1: Write failing schema-window tests**

Add focused unit assertions before the PostgreSQL integration tests:

```ts
import {
  MAX_SUPPORTED_SCHEMA_VERSION,
  SCHEMA_VERSION,
  assertSupportedSchema,
} from "./migrations.js";

test("the immediately next additive schema remains rollback-compatible", () => {
  assert.equal(SCHEMA_VERSION, 18);
  assert.equal(MAX_SUPPORTED_SCHEMA_VERSION, 19);
  assert.doesNotThrow(() => assertSupportedSchema([1, 18, 19]));
});

test("schemas beyond the declared rollback window are rejected", () => {
  assert.throws(
    () => assertSupportedSchema([1, 20]),
    /newer ship\.live schema/,
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --import tsx --test --test-name-pattern='rollback-compatible|rollback window' server/postgres-store.test.ts`

Expected: FAIL because `server/migrations.ts` does not exist.

- [ ] **Step 3: Create the manifest and replace the inline migration list**

Implement `server/migrations.ts` with the exact ordered filenames currently embedded in `PostgresEventStore.migrate`, then expose:

```ts
export const SCHEMA_VERSION = MIGRATION_FILES.length;
export const MAX_SUPPORTED_SCHEMA_VERSION = SCHEMA_VERSION + 1;

export function assertSupportedSchema(appliedVersions: readonly number[]) {
  if (appliedVersions.some((version) => version > MAX_SUPPORTED_SCHEMA_VERSION))
    throw new Error(
      "This database uses a newer ship.live schema. Upgrade the application before starting it.",
    );
}
```

Import `MIGRATION_FILES` and `assertSupportedSchema` in `postgres-store.ts`, read each manifest entry, and call `assertSupportedSchema(applied.rows.map(({ version }) => version))` while the advisory transaction lock is held. Keep migration application behavior unchanged.

- [ ] **Step 4: Prove both the pure contract and real migration suite pass**

Run: `node --import tsx --test --test-name-pattern='rollback-compatible|rollback window|migrations serialize' server/postgres-store.test.ts`

Expected: PASS when `TEST_DATABASE_URL` is present; the integration case may SKIP locally when it is absent.

Run with PostgreSQL: `TEST_DATABASE_URL=postgres://ship_live_test:ship_live_test@127.0.0.1:54329/postgres npm run test:db`

Expected: all PostgreSQL tests PASS and versions 1 through 18 remain applied exactly once.

- [ ] **Step 5: Commit the schema contract**

```bash
git add server/migrations.ts server/postgres-store.ts server/postgres-store.test.ts
git commit -m "feat: declare database rollback window"
```

### Task 2: Make Image Metadata and Smoke Testing Deterministic

**Files:**

- Create: `deploy/image-metadata.mjs`
- Create: `deploy/image-metadata.test.mjs`
- Modify: `Dockerfile`
- Modify: `deploy/runtime-image.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Consumes: release tag, full Git SHA, and exported schema constants.
- Produces: newline-delimited `VERSION=`, `REVISION=`, `SCHEMA_VERSION=`, and `MAX_SCHEMA_VERSION=` values plus image labels `org.opencontainers.image.source`, `org.opencontainers.image.revision`, `org.opencontainers.image.version`, `io.ship-live.schema-version`, and `io.ship-live.max-schema-version`.
- Produces: `SHIP_LIVE_TEST_IMAGE`, an optional prebuilt-image input for `deploy/runtime-image.test.mjs`.

- [ ] **Step 1: Write failing metadata and prebuilt-image tests**

Test valid metadata and rejection of non-SemVer versions or abbreviated SHAs:

```js
assert.deepEqual(metadata("v1.4.2", "a".repeat(40), 18, 19), {
  version: "v1.4.2",
  revision: "a".repeat(40),
  schemaVersion: 18,
  maxSchemaVersion: 19,
});
assert.throws(() => metadata("v1.4.2-rc.1", "a".repeat(40), 18, 19));
assert.throws(() => metadata("v1.4.2", "abc123", 18, 19));
```

Refactor the runtime test setup assertion so `SHIP_LIVE_TEST_IMAGE=example/image@sha256:...` skips `docker build`, loads `server/digest.ts`, and inspects all five labels on that same image.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test deploy/image-metadata.test.mjs`

Expected: FAIL because `deploy/image-metadata.mjs` does not exist.

- [ ] **Step 3: Implement metadata output and required Docker labels**

Make `deploy/image-metadata.mjs` validate inputs, import the schema constants through the `tsx` loader, and write GitHub-output-safe scalar lines. Add required Docker build arguments and labels:

```dockerfile
ARG RELEASE_VERSION
ARG VCS_REVISION
ARG SCHEMA_VERSION
ARG MAX_SCHEMA_VERSION
LABEL org.opencontainers.image.source="https://github.com/vndee/ship.live" \
      org.opencontainers.image.revision="$VCS_REVISION" \
      org.opencontainers.image.version="$RELEASE_VERSION" \
      io.ship-live.schema-version="$SCHEMA_VERSION" \
      io.ship-live.max-schema-version="$MAX_SCHEMA_VERSION"
```

Do not give the build arguments production-looking defaults. Make the local runtime smoke test pass `v0.0.0`, forty zeroes as its revision, and the imported schema constants explicitly. Release builds must pass all four arguments from validated metadata.

Update `runtime-image.test.mjs` to build only when `SHIP_LIVE_TEST_IMAGE` is absent. When supplied, never remove the caller-owned image in teardown. In both modes, run the digest-module import and inspect the label contract.

Add `test:image-metadata` and run both metadata and Docker tests with `node --import tsx` so their `.mjs` files can consume the TypeScript schema constants. Keep `test:docker` as the Docker-bearing smoke command.

- [ ] **Step 4: Run metadata and runtime image tests GREEN**

Run: `npm run test:image-metadata`

Expected: PASS.

Run: `npm run test:docker`

Expected: Docker build succeeds, the module imports, and every required label is present.

- [ ] **Step 5: Commit the image contract**

```bash
git add Dockerfile deploy/image-metadata.mjs deploy/image-metadata.test.mjs deploy/runtime-image.test.mjs package.json
git commit -m "feat: label immutable release images"
```

### Task 3: Validate Release Identity Before Granting Publish Access

**Files:**

- Create: `deploy/release-policy.mjs`
- Create: `deploy/release-policy.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Consumes CLI options `--tag`, `--target`, `--release-sha`, `--main-ref`, and `--package-version`.
- Produces validated JSON `{ tag, version, revision, shaTag }` on stdout; exits nonzero without printing credentials on invalid input.

- [ ] **Step 1: Write failing pure and git-ancestry tests**

Cover the exact accepted case plus malformed, prerelease, package mismatch, release-target mismatch, and non-main ancestry cases. Build a temporary git repository with a `main` commit and a side commit for ancestry assertions:

```js
assert.deepEqual(
  validateRelease({
    tag: "v1.4.2",
    target: sha,
    releaseSha: sha,
    mainContainsRelease: true,
    packageVersion: "1.4.2",
  }),
  { tag: "v1.4.2", version: "1.4.2", revision: sha, shaTag: `sha-${sha}` },
);
```

- [ ] **Step 2: Run the policy test and verify RED**

Run: `node --test deploy/release-policy.test.mjs`

Expected: FAIL because the policy module does not exist.

- [ ] **Step 3: Implement fail-closed validation**

Use `/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/` and `/^[0-9a-f]{40}$/`. The CLI must run:

```text
git rev-parse refs/tags/<tag>^{commit}
git merge-base --is-ancestor <release-sha> <main-ref>
```

Compare the resolved tag SHA with the event release target SHA and compare the stripped version with `package.json`. Return only normalized validated values.

- [ ] **Step 4: Run all release-policy cases GREEN**

Run: `node --test deploy/release-policy.test.mjs`

Expected: PASS for the main-history stable tag and PASS-by-rejection for every invalid fixture.

- [ ] **Step 5: Commit the release gate**

```bash
git add deploy/release-policy.mjs deploy/release-policy.test.mjs package.json
git commit -m "feat: validate production release tags"
```

### Task 4: Track a Pull-Only Production Compose Definition

**Files:**

- Create: `compose.external.yml`
- Create: `deploy/compose-external.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Consumes: `.env.production`, `APP_DOMAIN`, and mandatory digest-form `APP_IMAGE`.
- Produces: services `app` and `caddy` on the private network while preserving the existing certificate mount and Caddy volumes.

- [ ] **Step 1: Write the failing Compose contract test**

The test must execute Compose config with a harmless fixture environment and assert:

```js
assert.equal(config.services.app.build, undefined);
assert.equal(
  config.services.app.image,
  `ghcr.io/vndee/ship.live@sha256:${"a".repeat(64)}`,
);
assert.deepEqual(config.services.app.tmpfs, ["/tmp:size=64m,mode=1777"]);
assert.equal(config.services.app.read_only, true);
assert.equal(config.services.caddy.depends_on.app.condition, "service_healthy");
```

It must also run config without `APP_IMAGE` and require a nonzero status mentioning `APP_IMAGE`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test deploy/compose-external.test.mjs`

Expected: FAIL because `compose.external.yml` is absent.

- [ ] **Step 3: Add the external Compose definition**

Copy the known production service shape, using:

```yaml
services:
  app:
    image: ${APP_IMAGE:?Set APP_IMAGE to an immutable GHCR digest}
    env_file:
      - .env.production
    environment:
      NODE_ENV: production
      PORT: 3001
      APP_URL: https://${APP_DOMAIN:?Set APP_DOMAIN in .env.production}
      TRUST_PROXY_HOPS: 1
```

Preserve `restart`, `init`, `expose`, `read_only`, `/tmp`, the Supabase CA mount, network, logging, and Caddy settings from production. Do not add `build:` or registry credentials.

- [ ] **Step 4: Run Compose contract tests GREEN**

Run: `node --test deploy/compose-external.test.mjs`

Expected: PASS with the digest fixture and PASS-by-rejection when `APP_IMAGE` is missing.

- [ ] **Step 5: Commit the production Compose contract**

```bash
git add compose.external.yml deploy/compose-external.test.mjs package.json
git commit -m "feat: pull production image by digest"
```

### Task 5: Implement the Restricted Host Deployment Transaction

**Files:**

- Create: `deploy/ship-live-deploy`
- Create: `deploy/ship-live-deploy-ssh`
- Create: `deploy/ship-live-deploy.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Consumes: exactly one reference matching `^ghcr\.io/vndee/ship\.live@sha256:[0-9a-f]{64}$`; the root transaction accepts it as its sole argument and the unprivileged adapter accepts it as the entire `SSH_ORIGINAL_COMMAND` value.
- Reads: `/opt/apps/ship-live/.env.production`, `/opt/apps/ship-live/compose.external.yml`, and `/var/lib/ship-live-deploy/current` plus `previous`.
- Produces: atomically written state fields `IMAGE`, `VERSION`, `REVISION`, `SCHEMA_VERSION`, `MAX_SCHEMA_VERSION`, and `DEPLOYED_AT`.

- [ ] **Step 1: Write failing fake-runtime tests**

Create temporary fake `docker`, `docker-compose`, and `curl` executables that append argv to a log and return fixture responses. Cover these named cases:

```text
rejects tags, flags, extra arguments, uppercase digests, and alternate images
passes one validated SSH_ORIGINAL_COMMAND value to sudo without eval or word splitting
serializes with flock and exits before docker pull on contention
leaves the current app untouched when pull or label validation fails
rejects missing, malformed, or mismatched source/version/revision/schema labels
rejects a target version not newer than recorded production
recreates only app with APP_IMAGE set to the requested digest
records current and previous state only after Docker and public health pass
rolls back and health-checks the previous digest when max-schema covers target schema
refuses rollback when the previous max-schema is below target schema
stops the failed app but leaves Caddy running when schema compatibility forbids rollback
preserves diagnostic state and exits nonzero when rollback health fails
retains current and previous digests while pruning only other ship.live images
prints only bounded app log tails and never renders Compose environment values
```

For the happy path, assert the command ordering is pull → inspect → Compose config → Compose up → Docker health → public curl → atomic state rename.

- [ ] **Step 2: Run deployment tests and verify RED**

Run: `node --test deploy/ship-live-deploy.test.mjs`

Expected: FAIL because `deploy/ship-live-deploy` does not exist.

- [ ] **Step 3: Implement validation, locking, and immutable state**

Implement `ship-live-deploy-ssh` with `set -eu`, the same exact regex, and no `eval`; after validation it executes `sudo -n -- /usr/local/sbin/ship-live-deploy "$SSH_ORIGINAL_COMMAND"`. Implement the root script with `set -eu`, a fixed production `PATH`, explicit constants, a `flock -n` lock, and the exact reference regex. Inspect labels with `docker image inspect --format`, then require:

```text
org.opencontainers.image.source=https://github.com/vndee/ship.live
org.opencontainers.image.revision=<40 lowercase hex>
org.opencontainers.image.version=v<major>.<minor>.<patch>
io.ship-live.schema-version=<positive integer>
io.ship-live.max-schema-version=<integer >= schema-version>
```

Use `sort -V` only on already validated version strings and reject equal or older production versions.

- [ ] **Step 4: Implement deploy, bounded health, and schema-aware rollback**

Render config before mutation, then execute only:

```sh
APP_IMAGE="$requested_image" docker-compose --env-file .env.production \
  -f compose.external.yml up -d --no-deps app
```

Poll `docker inspect` for no more than 120 seconds, failing early if the container exits or repeatedly restarts. Require `curl --fail --silent --show-error https://ship.duy.dev/api/health` to equal `{"status":"ok"}`. Write state to a root-owned temporary file with mode `0600`, `fsync` through a small standard-library Python invocation, then rename atomically.

On failure after recreation, print at most 100 app log lines, inspect the previous image label, and rollback only when `previous.max-schema-version >= target.schema-version`; health-check both Docker and public HTTPS again. If compatibility forbids rollback, stop only the failed app and leave Caddy running. Always exit nonzero after a failed target, even when rollback succeeds.

- [ ] **Step 5: Run the complete host transaction suite GREEN**

Run: `node --test deploy/ship-live-deploy.test.mjs`

Expected: every success, rejection, rollback, and rollback-failure branch PASS.

Run: `shellcheck deploy/ship-live-deploy deploy/ship-live-deploy-ssh`

Expected: no findings. If ShellCheck is unavailable locally, run its pinned container and record the exact image digest in the commit notes.

- [ ] **Step 6: Commit the deployment transaction**

```bash
git add deploy/ship-live-deploy deploy/ship-live-deploy-ssh deploy/ship-live-deploy.test.mjs package.json
git commit -m "feat: add health-checked production deploy"
```

### Task 6: Add Release-Only GitHub Actions Publishing and Deployment

**Files:**

- Create: `.github/workflows/release.yml`
- Create: `deploy/workflow-policy.test.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`

**Interfaces:**

- Consumes: GitHub `release.published`, `GITHUB_TOKEN`, environment variables `DEPLOY_HOST` and `DEPLOY_USER`, and environment secrets `DEPLOY_SSH_KEY` and `DEPLOY_KNOWN_HOSTS`.
- Produces: public `ghcr.io/vndee/ship.live:vX.Y.Z`, `ghcr.io/vndee/ship.live:sha-<sha>`, verified digest output, and one `production` deployment.

- [ ] **Step 1: Write failing workflow policy tests**

Read both YAML files as text and enforce exact security invariants without executing expressions:

```js
assert.match(release, /release:\s*\n\s*types:\s*\[published\]/);
assert.doesNotMatch(ci, /packages:\s*write|environment:\s*production/);
assert.match(release, /packages:\s*write/);
assert.match(release, /environment:\s*production/);
assert.match(
  release,
  /needs:\s*\[[^\]]*checks[^\]]*browser[^\]]*publish[^\]]*\]/s,
);
assert.match(release, /cancel-in-progress:\s*false/);
assert.doesNotMatch(release, /StrictHostKeyChecking=no|ssh-keyscan/);
```

Extract every `uses:` value and require a 40-character lowercase SHA after `@`. Assert the SSH step passes only the digest output as the remote command and that `publish` depends on all release gates.

- [ ] **Step 2: Run workflow policy tests and verify RED**

Run: `node --test deploy/workflow-policy.test.mjs`

Expected: FAIL because `release.yml` is absent.

- [ ] **Step 3: Keep ordinary CI read-only and add release validation gates**

Preserve the current `push` and `pull_request` triggers and top-level `contents: read`. Add the non-Docker deployment policy tests to `checks`.

Create `release.yml` with `on.release.types: [published]`, default `contents: read`, production concurrency with `cancel-in-progress: false`, and these jobs:

```text
validate -> checks
validate -> browser
validate + checks + browser -> publish
publish -> previous-schema-compatibility
publish + previous-schema-compatibility -> deploy
```

The validate job fetches `origin/main` and tags, checks out the event tag, runs `release-policy.mjs`, and exposes normalized tag/SHA values.

- [ ] **Step 4: Build once, smoke-test, publish, and verify the digest**

In `publish`, authenticate with `docker/login-action` using `github.actor` and `secrets.GITHUB_TOKEN`. Build `linux/amd64` with validated metadata, load the image locally, run:

```sh
SHIP_LIVE_TEST_IMAGE="$local_image" npm run test:docker
```

Push both immutable tags only after the smoke test passes. Resolve the digest from GHCR, inspect the remote manifest, and expose only `ghcr.io/vndee/ship.live@sha256:<digest>` to downstream jobs. Fail if an existing version tag resolves to a different digest.

- [ ] **Step 5: Add the previous-release database compatibility gate**

When an earlier stable tag exists, build its runtime image, start the workflow PostgreSQL service, let the new image apply its migrations, then run the previous image's `npm run db:migrate` against that migrated database. This proves the exact preceding release can open the new schema. For the repository's first stable tag, emit `first stable release: no previous image compatibility target` and require the bootstrap path rather than pretending rollback was tested.

- [ ] **Step 6: Add digest-only forced SSH deployment**

The `deploy` job uses `environment: production`, writes the key and known-hosts files with mode `0600`, validates the digest again, and invokes native SSH with forwarding disabled:

```sh
ssh -T \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$RUNNER_TEMP/known_hosts" \
  -i "$RUNNER_TEMP/deploy_key" \
  "$DEPLOY_USER@$DEPLOY_HOST" "$APP_IMAGE"
```

Do not copy source, Compose, `.env.production`, or secrets during release deployment.

- [ ] **Step 7: Run policy, formatting, and local workflow-adjacent tests GREEN**

Run: `npm run test:deploy`

Expected: metadata, release policy, Compose, host deployment, and workflow policy tests PASS.

Run: `npm run format:check`

Expected: PASS with pinned action references and valid formatted YAML.

- [ ] **Step 8: Commit the workflow**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml deploy/workflow-policy.test.mjs package.json
git commit -m "feat: deploy versioned GitHub releases"
```

### Task 7: Document Release and Recovery Operations

**Files:**

- Modify: `docs/releasing.md`
- Modify: `docs/self-host-docker.md`

**Interfaces:**

- Documents repository Release creation and GCP operator bootstrap/recovery contracts implemented in Tasks 1–6.

- [ ] **Step 1: Update the release checklist**

Replace the manual-deployment wording with the exact operator sequence:

```text
1. Update package.json and package-lock.json to X.Y.Z.
2. Move CHANGELOG entries into the dated release.
3. Merge and wait for CI on main.
4. Create annotated tag vX.Y.Z on that exact main commit.
5. Publish a non-prerelease GitHub Release.
6. Follow the release workflow through validate, gates, publish, compatibility, and production health.
```

State explicitly that pushing the tag alone, saving a draft, publishing a prerelease, or pushing `main` does not deploy.

- [ ] **Step 2: Document production bootstrap and recovery**

Add exact paths and permissions for `/opt/apps/ship-live`, `/usr/local/sbin/ship-live-deploy`, `/usr/local/bin/ship-live-deploy-ssh`, `/var/lib/ship-live-deploy`, the forced `authorized_keys` options, the four GitHub environment values, anonymous GHCR pull verification, manual digest invocation, state inspection, logs, and schema-incompatible failure recovery. The deploy account must not join the Docker group; `/etc/sudoers.d/ship-live-deploy` grants passwordless execution only of `/usr/local/sbin/ship-live-deploy *`, whose root-owned code validates its sole digest argument again. Document that GitHub-hosted runner addresses are dynamic, so `from=` is not added to this key; IP restriction is reconsidered only if the project adopts a stable runner egress range.

Include the forced key shape:

```text
command="/usr/local/bin/ship-live-deploy-ssh",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty ssh-ed25519 <public-key> ship-live-github-deploy
```

- [ ] **Step 3: Verify documentation and commit**

Run: `npx prettier --check docs/releasing.md docs/self-host-docker.md`

Expected: PASS.

Run: `rg -n 'push.*main.*deploy|build.*production host|StrictHostKeyChecking=no' docs/releasing.md docs/self-host-docker.md`

Expected: no obsolete or insecure instructions; the only push-to-main statement says it does not deploy.

```bash
git add docs/releasing.md docs/self-host-docker.md
git commit -m "docs: explain automated release deployment"
```

### Task 8: Verify Locally, Review, and Bootstrap Production Safely

**Files:**

- Verify all files changed in Tasks 1–7.
- Remote install targets: `/opt/apps/ship-live/compose.external.yml`, `/usr/local/sbin/ship-live-deploy`, `/usr/local/bin/ship-live-deploy-ssh`, `/etc/sudoers.d/ship-live-deploy`, and `/var/lib/ship-live-deploy/`.
- GitHub configuration: `production` environment and the GHCR package visibility.

**Interfaces:**

- Consumes: reviewed commits, GitHub repository administration, and SSH access through `gcp-eng-services`.
- Produces: a public package, restricted deploy credential, healthy digest-based production, and recorded rollback state.

- [ ] **Step 1: Run the complete local gate**

Run in order:

```bash
npm ci
npm run format:check
npm test
TEST_DATABASE_URL=postgres://ship_live_test:ship_live_test@127.0.0.1:54329/postgres npm run test:db
npm run build
npm run test:deploy
npm run test:docker
git diff --check
```

Expected: every command exits 0; the PostgreSQL run reports no skipped database tests.

- [ ] **Step 2: Obtain independent code and security review**

Review the complete diff against the approved spec. Block rollout on any unresolved Critical or Important finding, especially workflow permission escalation, shell injection, secret exposure, tag mutability, health false positives, or schema-unsafe rollback.

- [ ] **Step 3: Push the implementation without enabling automatic deployment**

Initially guard the `deploy` job with repository variable `PRODUCTION_DEPLOY_ENABLED == 'true'`, leave it unset, push the reviewed commits, and require ordinary CI green on the exact `main` SHA.

- [ ] **Step 4: Publish the first image without deploying**

Bump the package to the chosen first stable version, create its annotated matching tag, publish the GitHub Release, and require validate/checks/browser/publish GREEN. Confirm the deploy job is skipped. Set the GHCR package public and verify from the server without `docker login`:

```bash
docker pull ghcr.io/vndee/ship.live@sha256:<digest-from-workflow>
```

Expected: anonymous pull succeeds and image labels match the release tag and SHA.

- [ ] **Step 5: Install the reviewed host boundary**

Through `ssh gcp-eng-services`, preserve a timestamped root-readable backup of the existing untracked `compose.external.yml`, install the committed Compose file, install both deployment scripts root-owned mode `0755`, create the unprivileged deploy account without Docker-group membership, install the constrained sudoers entry with mode `0440` after `visudo -cf` succeeds, create `/var/lib/ship-live-deploy` root-owned mode `0700`, and render Compose with the published digest before altering the app.

Generate a dedicated Ed25519 key, add only the forced-command public entry, pin the verified server host key, then configure the GitHub `production` environment:

```text
Variable: DEPLOY_HOST
Variable: DEPLOY_USER
Secret: DEPLOY_SSH_KEY
Secret: DEPLOY_KNOWN_HOSTS
```

- [ ] **Step 6: Run the first digest deployment manually**

Invoke `/usr/local/sbin/ship-live-deploy ghcr.io/vndee/ship.live@sha256:<digest>` as root on GCP. Verify:

```bash
sudo docker inspect --format '{{.Image}} {{.State.Health.Status}} {{.RestartCount}}' ship-live_app_1
curl --fail --silent --show-error https://ship.duy.dev/api/health
sudo cat /var/lib/ship-live-deploy/current
```

Expected: running digest matches the workflow, health is `healthy`, restart count is `0`, public body is `{"status":"ok"}`, and recorded state matches image labels.

- [ ] **Step 7: Enable release deployment and rehearse rollback**

Set `PRODUCTION_DEPLOY_ENABLED=true`, publish the next patch GitHub Release, and require a complete automated deployment. Then use a controlled test image whose healthcheck fails but whose schema label is compatible; require the workflow to fail, the previous digest to return healthy, and production state to remain the last healthy release.

- [ ] **Step 8: Record final evidence**

Capture the release URL, Actions run URL, version tag, revision, GHCR digest, running container digest, Docker health/restart count, public health response, rollback rehearsal result, and confirmation that no build process runs on GCP. Do not mark the feature complete until all values agree.
