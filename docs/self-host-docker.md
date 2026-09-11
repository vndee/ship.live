# Self-host on a physical machine with Docker

This setup runs ship.live, PostgreSQL, and Caddy on one Linux machine. Caddy obtains and renews HTTPS certificates automatically. PostgreSQL is reachable only inside the Docker network, while ports 80 and 443 are the only public application ports.

This is the generic open-source self-host path: it builds the checked-out
source locally and is independent of the `vndee/ship.live` GitHub Release and
GCP automation. The managed service has a separate, digest-only operational
runbook at the end of this page.

The images support both AMD64 and ARM64. A small x86 mini PC, Raspberry Pi 4/5 with 64-bit Linux, or an ARM server can run the stack. Use at least 2 GB RAM, two CPU cores, and reliable storage. PostgreSQL data and Caddy certificates live in named Docker volumes and survive container replacement.

## Prerequisites

1. Install current Docker Engine with the Compose plugin on a supported 64-bit Linux distribution.
2. Give the machine a stable LAN address.
3. Point a public DNS `A`/`AAAA` record such as `ship.example.com` to the internet address of the machine.
4. Forward TCP ports 80 and 443, plus UDP 443 for HTTP/3, from the router to the machine. TCP 443 is required; UDP 443 is optional.
5. Confirm that the ISP does not block inbound ports or place the connection behind CGNAT. GitHub must be able to reach the webhook URL.

Do not expose PostgreSQL port 5432 on the router or host firewall.

## Configure secrets

From the repository root:

```sh
cp .env.self-host.example .env.self-host
chmod 600 .env.self-host
openssl rand -hex 32
openssl rand -hex 32
```

Use one generated value for `POSTGRES_PASSWORD` and the other for `TOKEN_ENCRYPTION_KEY`. Generate a separate webhook secret the same way. Keep `POSTGRES_PASSWORD` hexadecimal so it can be embedded safely in the internal PostgreSQL URL.

Edit `.env.self-host` and set `APP_DOMAIN`, Supabase Auth, and GitHub App values. Supabase and GitHub configuration can remain entirely blank for an initial preview boot, but sign-in and live GitHub data require complete credentials. Convert the GitHub private key to one line before pasting it:

```sh
awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' github-app.private-key.pem
```

Place the result between the quotes of `GITHUB_APP_PRIVATE_KEY`. Never commit `.env.self-host`; Git ignores it.

Use the resulting public origin in external settings:

| Setting                     | Value                                          |
| --------------------------- | ---------------------------------------------- |
| Supabase Site URL           | `https://ship.example.com`                     |
| Supabase redirect allowlist | `https://ship.example.com/api/auth/callback*`  |
| GitHub App callback         | `https://ship.example.com/api/github/callback` |
| GitHub App setup URL        | `https://ship.example.com/?github=installed`   |
| GitHub App webhook          | `https://ship.example.com/api/webhooks/github` |

Replace `ship.example.com` with `APP_DOMAIN`. The full GitHub permission and event list is in [configuration.md](configuration.md#set-up-the-github-app-for-activity).

## Start the stack

```sh
docker compose --env-file .env.self-host -f compose.self-host.yml up -d --build
docker compose --env-file .env.self-host -f compose.self-host.yml ps
docker compose --env-file .env.self-host -f compose.self-host.yml logs --tail=100 app caddy
```

The app applies database migrations before opening port 3001. Compose waits for PostgreSQL and the app healthcheck before starting Caddy. Open `https://APP_DOMAIN/api/health`; a healthy response confirms the app can reach PostgreSQL.

If the machine uses UFW, allow SSH before enabling the firewall, then allow web traffic:

```sh
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw enable
```

## Update

Back up first, then rebuild from the new commit:

```sh
git pull --ff-only
docker compose --env-file .env.self-host -f compose.self-host.yml build --pull app
docker compose --env-file .env.self-host -f compose.self-host.yml up -d
docker image prune -f
```

Caddy and PostgreSQL remain pinned to major or patch image versions in the Compose file. Review release notes before changing PostgreSQL's major version; replacing the image is not a database major-version upgrade procedure.

## Back up and restore PostgreSQL

Create a compressed logical backup outside the Docker volume:

```sh
mkdir -p backups
docker compose --env-file .env.self-host -f compose.self-host.yml exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "backups/ship-live-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

Copy backups to another physical device. A named volume protects against container replacement, not disk failure or accidental deletion.

To restore into an empty database, stop the app, recreate the database, and load a selected dump:

```sh
docker compose --env-file .env.self-host -f compose.self-host.yml stop app
docker compose --env-file .env.self-host -f compose.self-host.yml exec -T postgres \
  sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB"'
docker compose --env-file .env.self-host -f compose.self-host.yml exec -T postgres \
  sh -c 'createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose --env-file .env.self-host -f compose.self-host.yml exec -T postgres \
  sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
  < backups/selected.dump
docker compose --env-file .env.self-host -f compose.self-host.yml start app
```

Test restore procedures on a separate machine before depending on them. Preserve `TOKEN_ENCRYPTION_KEY` with the backups; GitHub grants stored in PostgreSQL cannot be decrypted without it.

## Operations

Useful commands:

```sh
docker compose --env-file .env.self-host -f compose.self-host.yml ps
docker compose --env-file .env.self-host -f compose.self-host.yml logs -f --tail=200
docker compose --env-file .env.self-host -f compose.self-host.yml restart app
docker stats
```

The health-probe scheduler runs inside the app container. Keep the machine powered on and disable automatic sleep. Configure the operating system to install security updates and restart during a planned maintenance window. Use a UPS if health monitoring must survive short power outages.

`docker compose down` preserves named volumes. Do not use `docker compose down -v` unless you intend to delete the PostgreSQL database and Caddy state.

## Managed ship.live production operations

This section is only for operators of the managed `vndee/ship.live` service.
It is not required for general self-hosters. The managed host never receives
source code, Compose secrets, or a build request from the release workflow; it
pulls a previously verified public GHCR image by immutable digest.

### Bootstrap the GHCR package and GitHub environment

Before publishing, land both `Release` (`.github/workflows/release.yml`) and
`Release publish` (`.github/workflows/release-publish.yml`) on protected `main`.
Restrict repository write and release authority to trusted maintainers, require
review and CI on `main`, audit workflow/policy changes, and configure the
`production` environment to allow deployments only from protected branches.
Keep deploy secrets exclusively in that environment. Check these controls
before setting `PRODUCTION_DEPLOY_ENABLED` to `true`.

Confirm that the environment has no custom deployment protection-rule app.
The job uses `environment: {name: production, deployment: false}`: reviewers,
wait timers, branch access restrictions, secrets, and variables still apply,
but custom protection apps are incompatible and make the job fail. If such an
app is required, leave deployment disabled until a compatible tracking design
is reviewed; do not remove the protection as a workaround.

The job suppresses GitHub's automatic deployment record because a `workflow_run`
consumer's SHA identifies current main, which can differ from the release. It
uses the Deployments API to record the validated release SHA, tag, and exact
digest, verifies the returned record, and marks it `in_progress` before SSH.
It marks that same record `success` only after the digest-only host command
succeeds, otherwise `failure`. If final status reporting fails, or the runner is
hard-killed, reconcile a possibly stale `in_progress` record with the host's
`current` digest and health before retrying or updating status. A failed SSH
attempt does not prove the host remained unchanged. See the [release tracking
details](releasing.md#publish-a-stable-release).

There are two linked Actions runs. The reviewed release-tag `Release` run has
only `contents: read` and uploads a bounded tag record. Its default-branch
`workflow_run` consumer, `Release publish`, downloads that exact run's artifact,
requires a successful release event, checks the canonical tag SHA against the
triggering head SHA and `main` ancestry, and confirms the current published,
non-draft, non-prerelease Release API record before executing repository policy
or release source. An unmerged or forged signal is rejected before this
consumer produces publication outputs. Follow both runs in Actions; the
consumer's triggering workflow run links back to the signal.

This protects the reviewed consumer, not against malicious repository writers.
GitHub permits a writer to replace workflow YAML and request broader token
permissions, including package writes. The signal's read-only declaration is
not a platform permission ceiling for writer-authored workflows. Preventing
that separate path requires registry authority outside this repository or an
additional human authorization boundary. The governance controls above and
trust in repository writers are prerequisites for this automatic design.

Publish the first stable GitHub Release with the repository variable
`PRODUCTION_DEPLOY_ENABLED` unset or not equal to `true`. Follow `Release`, then
wait in `Release publish` for
`validate`, `checks`, `browser`, and `publish` to pass and confirm that
`deploy` was skipped. Set the `vndee/ship.live` GHCR package visibility to
**Public**, then verify an anonymous pull from the managed host, without
`docker login`:

```sh
set -euo pipefail
umask 077
anonymous_config="$(mktemp -d "${TMPDIR:-/tmp}/ship-live-anonymous-registry.XXXXXX")"
trap 'rm -rf -- "$anonymous_config"' EXIT
printf '%s\n' '{"auths":{"ghcr.io":{}}}' > "$anonymous_config/config.json"
env -u DOCKER_AUTH_CONFIG docker --config "$anonymous_config" pull \
  ghcr.io/vndee/ship.live@sha256:<digest-from-publish-job>
docker image inspect ghcr.io/vndee/ship.live@sha256:<digest-from-publish-job> \
  --format '{{ index .Config.Labels "org.opencontainers.image.version" }} {{ index .Config.Labels "org.opencontainers.image.revision" }} {{ index .Config.Labels "io.ship-live.schema-version" }} {{ index .Config.Labels "io.ship-live.max-schema-version" }}'
```

The explicit empty GHCR auth map prevents Docker from auto-selecting a native
credential helper, and unsetting `DOCKER_AUTH_CONFIG` prevents injected
credentials from making a private package appear public. The trap removes the
temporary config on success or failure. The displayed version and revision must
match the Release and its exact tag commit. Configure the GitHub `production`
environment with exactly these four connection values:

| Kind     | Name                 | Value                                                                |
| -------- | -------------------- | -------------------------------------------------------------------- |
| Variable | `DEPLOY_HOST`        | Verified DNS name or IP address of the managed host.                 |
| Variable | `DEPLOY_USER`        | The restricted deploy account name.                                  |
| Secret   | `DEPLOY_SSH_KEY`     | Private half of the dedicated Ed25519 deploy key.                    |
| Secret   | `DEPLOY_KNOWN_HOSTS` | Pinned, independently verified SSH host-key entry for `DEPLOY_HOST`. |

`PRODUCTION_DEPLOY_ENABLED=true` is a separate repository variable and is the
final automatic-deployment gate. Do not set it until the host boundary, the
anonymous image pull, and a manual digest deployment have all been verified.
The workflow uses strict host-key checking and must not be changed to discover
or accept a host key at runtime.

### Install the host boundary

Use a supported Linux host with Docker Engine, the `docker-compose` executable
(the deployed script invokes that exact command), `curl`, `python3`, `flock`,
GNU `timeout`, and standard Bash utilities including `date`, `mktemp`, `sort`,
and `tail`. Docker's Unix socket remains root-owned. Create a dedicated,
unprivileged deploy account, but do **not** add it to the `docker` group.

Install the reviewed files at these fixed root-owned locations and modes:

| Path                                       | Owner and mode      | Purpose                                                           |
| ------------------------------------------ | ------------------- | ----------------------------------------------------------------- |
| `/opt/apps/ship-live`                      | `root:root`, `0755` | Managed application directory.                                    |
| `/opt/apps/ship-live/compose.external.yml` | `root:root`, `0644` | Digest-only external Compose definition.                          |
| `/opt/apps/ship-live/.env.production`      | `root:root`, `0600` | Managed production configuration and secrets.                     |
| `/usr/local/sbin/ship-live-deploy`         | `root:root`, `0755` | Root deployment transaction.                                      |
| `/usr/local/bin/ship-live-deploy-ssh`      | `root:root`, `0755` | Forced SSH command wrapper.                                       |
| `/var/lib/ship-live-deploy`                | `root:root`, `0700` | Lock and durable `current`, `previous`, and `last-failure` state. |
| `/etc/sudoers.d/ship-live-deploy`          | `root:root`, `0440` | Narrow sudo permission for the deploy account.                    |

Complete the one-time fallback capture and compatibility rehearsal below
**before** overwriting the existing `compose.external.yml` or replacing the app.
Install the Caddy
configuration and Supabase CA file at the paths referenced by that Compose
file, set `APP_DOMAIN` and the rest of `.env.production`, and render it with a
published digest before touching the running app:

```sh
sudo install -d -o root -g root -m 0755 /opt/apps/ship-live
sudo install -o root -g root -m 0644 compose.external.yml /opt/apps/ship-live/compose.external.yml
sudo install -o root -g root -m 0755 deploy/ship-live-deploy /usr/local/sbin/ship-live-deploy
sudo install -o root -g root -m 0755 deploy/ship-live-deploy-ssh /usr/local/bin/ship-live-deploy-ssh
sudo install -d -o root -g root -m 0700 /var/lib/ship-live-deploy
cd /opt/apps/ship-live
sudo APP_IMAGE=ghcr.io/vndee/ship.live@sha256:<verified-digest> \
  docker-compose --env-file .env.production -f compose.external.yml config --quiet
```

The sudoers file must use `env_reset`, must not allow `SETENV`, and may grant
passwordless execution only to the root script with its one argument pattern:

```sudoers
<deploy-user> ALL=(root) NOPASSWD: /usr/local/sbin/ship-live-deploy *
```

Validate the file with `visudo -cf /etc/sudoers.d/ship-live-deploy` before
installing it at mode `0440`. The wildcard is not a general root shell: the
root-owned script fixes its own `PATH`, ignores caller Docker and Compose
configuration, and rejects anything except one lower-case digest reference of
the form `ghcr.io/vndee/ship.live@sha256:<64-hex-digest>`.

Generate a dedicated Ed25519 key for GitHub Actions. Give the deploy account
an `.ssh` directory at mode `0700` and an `authorized_keys` file at mode
`0600` containing only this forced-command entry (substitute the public key):

```text
command="/usr/local/bin/ship-live-deploy-ssh",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty ssh-ed25519 <public-key> ship-live-github-deploy
```

Do not add `from=` to this key: GitHub-hosted runner addresses are dynamic.
Reconsider an IP restriction only if this project adopts a stable runner egress
range. The forced wrapper accepts no SSH command except the same digest syntax,
then uses `sudo -n -- /usr/local/sbin/ship-live-deploy "$SSH_ORIGINAL_COMMAND"`.

### Manual verification and normal release deployment

Before enabling automation, invoke the exact verified digest as root. Do not
use a mutable tag:

```sh
sudo /usr/local/sbin/ship-live-deploy \
  ghcr.io/vndee/ship.live@sha256:<verified-digest>
```

The transaction pulls the image, checks the required source, version,
revision, and schema-range labels, validates Compose, recreates only `app`,
and waits up to 120 seconds. Success requires a running, Docker-healthy app
with restart count `0`, `1`, or `2`, plus HTTPS `https://ship.duy.dev/api/health` returning
HTTP `200` with the exact body `{"status":"ok"}`. It commits state only after
those checks pass.

Inspect the result and bounded operational logs with the exact state files and
Compose project:

```sh
sudo bash
set -euo pipefail
cd /opt/apps/ship-live
export COMPOSE_PROJECT_NAME=ship-live
APP_IMAGE="$(sed -n 's/^IMAGE=//p' /var/lib/ship-live-deploy/current)"
[[ "$APP_IMAGE" =~ ^ghcr\.io/vndee/ship\.live@sha256:[0-9a-f]{64}$ ]]
export APP_IMAGE
container="$(docker-compose --env-file .env.production -f compose.external.yml ps -q app)"
[[ "$container" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]
test "$(docker inspect --format '{{.Config.Image}}' "$container")" = "$APP_IMAGE"
image_id="$(docker inspect --format '{{.Image}}' "$container")"
docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image_id" | grep -Fx -- "$APP_IMAGE"
docker inspect --format '{{.Config.Image}} {{.State.Health.Status}} {{.RestartCount}}' "$container"
curl --fail --silent --show-error https://ship.duy.dev/api/health
cat /var/lib/ship-live-deploy/current
docker-compose --env-file .env.production -f compose.external.yml logs --no-color --tail=100 app
exit
```

`previous` or `last-failure` may not exist on the first run. The state records
the immutable image, release version and revision, schema range, and timestamp;
compare them to the image labels and workflow digest. Only after this manual
check should an operator set `PRODUCTION_DEPLOY_ENABLED=true` and publish the
next stable GitHub Release. The workflow sends only the verified digest through
the forced SSH boundary.

### One-time fallback before the first digest replacement

With empty `current` state, the deployment transaction cannot automatically
roll back. It stops a failed first app and records `last-failure`. Keep
`PRODUCTION_DEPLOY_ENABLED` disabled throughout bootstrap. The existing app
image and its working Compose configuration are the operator's fallback.

Run the following in a root Bash session on the host **before installing the
new Compose file**. Set `TARGET_IMAGE` to the verified first GHCR digest and
`PROBE_FILE` to the absolute path of the reviewed `deploy/previous-store-probe.mjs`.
Do not use a production database URL for the rehearsal. This deliberately
requires byte-identical migration sets for the first transition; a schema
change needs a separately reviewed database recovery plan before bootstrap.

```sh
set -euo pipefail
umask 077
cd /opt/apps/ship-live
export COMPOSE_PROJECT_NAME=ship-live
TARGET_IMAGE=ghcr.io/vndee/ship.live@sha256:<verified-digest>
PROBE_FILE=/absolute/path/to/reviewed/deploy/previous-store-probe.mjs
[[ "$TARGET_IMAGE" =~ ^ghcr\.io/vndee/ship\.live@sha256:[0-9a-f]{64}$ ]]
install -d -o root -g root -m 0700 /var/lib/ship-live-deploy
test ! -e /var/lib/ship-live-deploy/current
test ! -e /var/lib/ship-live-deploy/previous
exec 9>/var/lib/ship-live-deploy/lock
flock -n 9
BOOTSTRAP_DIR="$(mktemp -d /var/lib/ship-live-deploy/bootstrap.XXXXXXXX)"
container="$(docker-compose --env-file .env.production -f compose.external.yml ps -q app)"
[[ "$container" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]
test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container")" = ship-live
test "$(docker inspect --format '{{.State.Status}}|{{.State.Health.Status}}' "$container")" = 'running|healthy'
docker inspect "$container" > "$BOOTSTRAP_DIR/container.json"
docker exec "$container" node --input-type=module -e '
  import pg from "pg";
  const pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
  try {
    const result = await pool.query("SELECT version FROM ship_live_schema_migrations ORDER BY version");
    console.log(JSON.stringify(result.rows.map(row => row.version)));
  } finally { await pool.end(); }
' > "$BOOTSTRAP_DIR/applied-schema.json"
legacy_image="$(docker inspect --format '{{.Image}}' "$container")"
[[ "$legacy_image" =~ ^sha256:[0-9a-f]{64}$ ]]
printf '%s\n' "$legacy_image" > "$BOOTSTRAP_DIR/image-id"
cp -p compose.external.yml "$BOOTSTRAP_DIR/original.compose.yml"
cp -p .env.production "$BOOTSTRAP_DIR/.env.production"
docker-compose --env-file .env.production -f compose.external.yml config > "$BOOTSTRAP_DIR/working.compose.yml"
printf 'version: "2.4"\nservices:\n  app:\n    image: %s\n' "$legacy_image" > "$BOOTSTRAP_DIR/fallback-image.yml"
retained_tag="ship-live-bootstrap:$(basename "$BOOTSTRAP_DIR")"
docker image tag "$legacy_image" "$retained_tag"
docker image save --output "$BOOTSTRAP_DIR/legacy-image.tar" "$retained_tag"
chmod 0600 "$BOOTSTRAP_DIR"/* "$BOOTSTRAP_DIR/.env.production"
```

The archive retains the exact image even if Compose removes the old container.
`container.json` retains that container's identity and configuration. The
rendered Compose file contains secrets and absolute bind-mount paths: keep it
root-readable only, retain the referenced Caddy/CA files, and never upload it.
Keep the retained image tag and archive until a later healthy digest release
and rollback rehearsal establish the normal `current`/`previous` pair.

In the same session, run this isolated rehearsal. The temporary database has
synthetic credentials, no host port, and an internal Docker network. No
production environment or certificate is mounted into it.

```sh
migration_manifest='const fs=require("node:fs"),crypto=require("node:crypto"); for(const f of fs.readdirSync("server/migrations").filter(f=>/^[0-9]+_.*\.sql$/.test(f)).sort()) console.log(f+" "+crypto.createHash("sha256").update(fs.readFileSync("server/migrations/"+f)).digest("hex"))'
docker run --rm --network none --entrypoint node "$legacy_image" -e "$migration_manifest" > "$BOOTSTRAP_DIR/legacy-migrations"
docker run --rm --network none --entrypoint node "$TARGET_IMAGE" -e "$migration_manifest" > "$BOOTSTRAP_DIR/target-migrations"
test -s "$BOOTSTRAP_DIR/legacy-migrations"
cmp "$BOOTSTRAP_DIR/legacy-migrations" "$BOOTSTRAP_DIR/target-migrations"
python3 -I - "$BOOTSTRAP_DIR" <<'PY'
import json, pathlib, sys
backup = pathlib.Path(sys.argv[1])
expected = [int(line.split('_', 1)[0]) for line in (backup / 'legacy-migrations').read_text().splitlines()]
assert json.loads((backup / 'applied-schema.json').read_text()) == expected, 'Live schema must match the retained migration set'
PY
bootstrap_network="ship-live-$(basename "$BOOTSTRAP_DIR")"
bootstrap_database="$bootstrap_network-db"
docker network create --internal "$bootstrap_network" > /dev/null
trap 'docker rm -fv "$bootstrap_database" >/dev/null 2>&1 || true; docker network rm "$bootstrap_network" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$bootstrap_database" --network "$bootstrap_network" \
  -e POSTGRES_USER=ship_live_test -e POSTGRES_PASSWORD=ship_live_test \
  -e POSTGRES_DB=ship_live_compatibility postgres:18-alpine > /dev/null
for attempt in {1..30}; do
  if docker exec "$bootstrap_database" pg_isready -U ship_live_test -d ship_live_compatibility > /dev/null; then break; fi
  sleep 2
done
docker exec "$bootstrap_database" pg_isready -U ship_live_test -d ship_live_compatibility > /dev/null
probe_database="postgres://ship_live_test:ship_live_test@$bootstrap_database:5432/ship_live_compatibility"
docker run --rm --network "$bootstrap_network" -e "DATABASE_URL=$probe_database" \
  --mount "type=bind,source=$PROBE_FILE,target=/app/previous-store-probe.mjs,readonly" \
  --entrypoint node "$legacy_image" --import tsx /app/previous-store-probe.mjs seed
docker run --rm --network "$bootstrap_network" -e "DATABASE_URL=$probe_database" "$TARGET_IMAGE" npm run db:migrate
docker run --rm --network "$bootstrap_network" -e "DATABASE_URL=$probe_database" \
  --mount "type=bind,source=$PROBE_FILE,target=/app/previous-store-probe.mjs,readonly" \
  --entrypoint node "$legacy_image" --import tsx /app/previous-store-probe.mjs verify
printf '%s\n%s\n' "$TARGET_IMAGE" "$legacy_image" > "$BOOTSTRAP_DIR/schema-safe"
printf 'Retain bootstrap directory: %s\n' "$BOOTSTRAP_DIR"
exit
```

Only after this passes, install the new Compose file and host boundary, render
its config privately, and compare it with the saved working model: the app
image source must be the only material change. Then perform the first manual
digest deployment. If that attempt fails with empty state, run the block below
as root with `BOOTSTRAP_DIR` set to the retained directory and `TARGET_IMAGE`
set to the attempted digest. These are one-time operator recovery commands;
they are never accepted through the forced SSH key. If the image is missing,
first load the retained archive with `docker image load --input
"$BOOTSTRAP_DIR/legacy-image.tar"`.

<!-- bootstrap-restore:start -->

```sh
set -euo pipefail
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077
APP_DIR=/opt/apps/ship-live
STATE_DIR=/var/lib/ship-live-deploy
test "$(id -u)" -eq 0
exec 9>"$STATE_DIR/lock"
flock -n 9
test ! -e "$STATE_DIR/current"
test ! -e "$STATE_DIR/previous"
legacy_image="$(cat "$BOOTSTRAP_DIR/image-id")"
[[ "$legacy_image" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "$TARGET_IMAGE" =~ ^ghcr\.io/vndee/ship\.live@sha256:[0-9a-f]{64}$ ]]
cmp "$BOOTSTRAP_DIR/schema-safe" <(printf '%s\n%s\n' "$TARGET_IMAGE" "$legacy_image")
test "$(timeout --signal=TERM --kill-after=1 19 docker image inspect --format '{{.Id}}' "$legacy_image")" = "$legacy_image"
cd "$APP_DIR"
export COMPOSE_PROJECT_NAME=ship-live APP_IMAGE="$legacy_image"
compose_args=(--project-directory "$APP_DIR" --env-file "$BOOTSTRAP_DIR/.env.production" -f "$BOOTSTRAP_DIR/working.compose.yml" -f "$BOOTSTRAP_DIR/fallback-image.yml")
timeout --signal=TERM --kill-after=1 19 docker-compose "${compose_args[@]}" config --quiet > /dev/null 2>&1
timeout --signal=TERM --kill-after=1 59 docker-compose "${compose_args[@]}" up -d --no-build --no-deps app > /dev/null 2>&1
deadline=$((SECONDS + 120))
bounded() {
  local remaining=$((deadline - SECONDS))
  test "$remaining" -ge 2 || return 1
  if (( remaining > 10 )); then remaining=10; fi
  timeout --signal=TERM --kill-after=1 "$((remaining - 1))" "$@"
}
container="$(bounded docker-compose "${compose_args[@]}" ps -q app)"
[[ "$container" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]
test "$(bounded docker inspect --format '{{.Image}}' "$container")" = "$legacy_image"
ready=false
while (( SECONDS < deadline )); do
  health="$(bounded docker inspect --format '{{.State.Status}}|{{.State.Health.Status}}|{{.RestartCount}}' "$container")"
  case "$health" in
    running\|healthy\|[012]) ready=true; break ;;
    running\|starting\|[012]|restarting\|starting\|[012]) sleep 2 ;;
    *) exit 1 ;;
  esac
done
test "$ready" = true
curl --fail --silent --show-error --connect-timeout 5 --max-time 10 \
  --output "$BOOTSTRAP_DIR/health-body" --write-out '%{http_code}' \
  https://ship.duy.dev/api/health > "$BOOTSTRAP_DIR/health-code"
cmp "$BOOTSTRAP_DIR/health-body" <(printf '%s' '{"status":"ok"}')
cmp "$BOOTSTRAP_DIR/health-code" <(printf '%s' '200')
printf '%s\n' 'Retained bootstrap image restored and healthy; deployment state remains empty.'
```

<!-- bootstrap-restore:end -->

The restoration has 20-second image-inspection and config bounds, a 60-second recreation bound,
120-second Docker-health deadline, and 10-second public-health bound. Any
failed check exits nonzero; preserve the archive and `last-failure`, keep
automation disabled, and investigate before another attempt. It neither
creates a synthetic `current` record nor claims automatic rollback.
Keep migrations and database administration frozen between this rehearsal and
the first replacement/restoration. If another actor changes the database,
invalidate the `schema-safe` evidence and reassess compatibility before restoring.

### Retry, interrupted transactions, and credential rotation

An SSH timeout can occur after health and durable state commit. Repeating the
same version is intentionally rejected as not newer. First resolve the app
through Compose and compare `current.IMAGE` with both `.Config.Image` and the
running image's `RepoDigests`, then verify Docker/public health and release
labels using the commands above. A matching, healthy committed release needs
no rerun. Do not bump a version solely to hide an uncertain outcome.

For SIGKILL or power loss, pause automation and hold the deployment lock during
operator recovery. Save `current`, `previous`, `last-failure`, container inspect
output, and bounded logs privately. The container can have changed before
`current` was committed; `previous` may already equal `current` because the
records are written separately. Compare exact image references, not container
names or configuration IDs alone. If the running image differs, do not edit
state to match it or blindly rerun the release. Establish the actual database
migration level with the database operator. Restore the recorded `current`
digest only when its maximum supported schema covers the database, using the
same root-only Compose recreation and bounded Docker/public health checks;
retain the existing records. Otherwise recover with a reviewed higher-version
compatible release or an explicit database recovery. With empty state use the
one-time fallback only if its exact `schema-safe` evidence still covers the
attempted image and no later schema changes occurred.

For deploy-key rotation, disable automatic deployment and let any active
transaction finish. Generate a new dedicated Ed25519 key, add its public entry
with the identical forced-command and forwarding restrictions, update the
`production` environment's `DEPLOY_SSH_KEY`, and check authentication using
an invalid digest command (it must reach the wrapper and be rejected without
deploying). Remove the old authorized-key entry and securely retire the old
private key, then re-enable the gate. Never grant a shell to test rotation.
For host-key rotation, obtain the replacement fingerprint through the GCP
console or another independently authenticated channel, install/update
`DEPLOY_KNOWN_HOSTS` for the exact host and port, and verify strict checking with
the same non-deploying rejection test. Remove the superseded host key only
after the replacement is verified; never disable strict checking or trust
runtime `ssh-keyscan` output as the authority.

### Failure and recovery

When a target deployment fails after the app was changed, the root script
stores `last-failure`, prints at most 100 app log lines, and rolls back to the
pre-attempt `current` image only when that image's
`io.ship-live.max-schema-version` covers the target image's
`io.ship-live.schema-version`. `previous` is the older successful slot, not
the automatic rollback source: after a successful `A` to `B` deployment, a
failed `C` attempt restores `B` from `current` while `previous` still contains
`A`. A successful rollback must itself pass the same Docker and public-health
checks; `current` remains the last healthy committed release.

If the schema range is incompatible, rollback is deliberately refused and the
target app is stopped. Do not force an older image, edit the durable state, or
override the forced-command/sudo boundary. Preserve `current`, `previous`, and
`last-failure`, collect the bounded logs, pause release automation, and use the
database backup and migration recovery procedure from the release owner. Bring
the service back only with a newly reviewed, schema-compatible, higher-version
release through the digest transaction, or after an explicit operator-led
database recovery. This failure mode requires operator intervention rather
than claiming that an unsafe rollback succeeded.
