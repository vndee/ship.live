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

Publish the first stable GitHub Release with the repository variable
`PRODUCTION_DEPLOY_ENABLED` unset or not equal to `true`. Wait for
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

Preserve a timestamped, root-readable backup of any existing untracked
`compose.external.yml` before installing the reviewed file. Install the Caddy
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
with restart count `0`, plus HTTPS `https://ship.duy.dev/api/health` returning
HTTP `200` with the exact body `{"status":"ok"}`. It commits state only after
those checks pass.

Inspect the result and bounded operational logs with the exact state files and
Compose project:

```sh
sudo docker inspect --format '{{.Image}} {{.State.Health.Status}} {{.RestartCount}}' ship-live_app_1
curl --fail --silent --show-error https://ship.duy.dev/api/health
sudo cat /var/lib/ship-live-deploy/current
sudo cat /var/lib/ship-live-deploy/previous
sudo cat /var/lib/ship-live-deploy/last-failure
sudo sh -c 'cd /opt/apps/ship-live && APP_IMAGE=ghcr.io/vndee/ship.live@sha256:<verified-digest> docker-compose --env-file .env.production -f compose.external.yml logs --no-color --tail=100 app'
```

`previous` or `last-failure` may not exist on the first run. The state records
the immutable image, release version and revision, schema range, and timestamp;
compare them to the image labels and workflow digest. Only after this manual
check should an operator set `PRODUCTION_DEPLOY_ENABLED=true` and publish the
next stable GitHub Release. The workflow sends only the verified digest through
the forced SSH boundary.

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
