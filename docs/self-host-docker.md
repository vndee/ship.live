# Self-host on a physical machine with Docker

This setup runs ship.live, PostgreSQL, and Caddy on one Linux machine. Caddy obtains and renews HTTPS certificates automatically. PostgreSQL is reachable only inside the Docker network, while ports 80 and 443 are the only public application ports.

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
