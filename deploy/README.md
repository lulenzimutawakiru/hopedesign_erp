# Hope Design ERP on an AccuWeb Linux VPS

Production Docker stack: **Caddy** (HTTPS) -> **web** (nginx SPA) + **two API colors** (Node 20, `api-a`/`api-b`) + **Postgres 16**. Only ports **80** and **443** are published; Postgres, Redis access and internal services stay on the compose network.

## What you need

- AccuWeb **Linux VPS** (Ubuntu 22.04/24.04 or Debian) with **root SSH**
- At least **2 vCPU / 4 GB RAM / 40 GB disk** (8 GB RAM is more comfortable with Postgres on-box)
- A domain **A record** pointing at the VPS public IP (required for Let's Encrypt)
- Ports **80** and **443** free (disable AccuWeb's default Apache/nginx if bound there)

## 1. SSH in and install Docker

```bash
ssh -p 2978 root@YOUR_VPS_IP
# copy this repo onto the VPS, then:
sudo sh deploy/vps-setup.sh
```

## 2. Secrets and compose env

On the VPS, in the repo root:

```bash
node deploy/generate-env.mjs --domain hopedesign.jorlentech.com --email admin@hopedesign.jorlentech.com --seed
```

This writes the gitignored `.env.production`. The production compose file requires `DOMAIN`, `ACME_EMAIL` and `POSTGRES_PASSWORD`.

## 3. First start

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.production ps
curl -fsS https://hopedesign.jorlentech.com/api/health
```

The Caddy container entrypoint (`deploy/caddy-entrypoint.sh`) writes the initial `deploy/caddy-live/active.caddy` (defaults to `api-a`) if it does not exist.

## Zero-downtime architecture (blue/green API)

- **Two always-running API colors** `api-a` and `api-b` share the `uploads` volume and the same Postgres. Caddy routes `/api` to **exactly one ACTIVE color** through an imported snippet `deploy/caddy-live/active.caddy`.
- **Atomic flip.** A rollout rebuilds the *idle* color, waits for it to become Docker-healthy, rewrites `active.caddy` and runs `caddy reload`. The flip is atomic, so in-flight requests are not dropped and no request is ever routed to an unhealthy process.
- **Workers are single-flight.** Both colors guard periodic jobs (report schedules, cron jobs, the Hikvision queue, notifications) with Postgres advisory locks, so two running API processes never execute the same job twice.
- **Boot migrations are advisory-locked**, so both colors can start against the same database without racing DDL.
- **Watchdog** (`deploy/stack-watchdog.sh`, installed every 2 minutes by `deploy/install-watchdog.sh`) flips Caddy to the healthy idle color if the active color dies, restarts dead `postgres`/`web`/`caddy` containers, and recreates both API colors if neither answers `/api/health`.
- **Backups.** `deploy/postgres-backup.sh` (daily) and `deploy/storage-backup.sh` (daily) run from cron and are safe during a rollout (storage backup snapshots from whichever API color is running).

## Day-2 operations

```bash
# zero-downtime rollout (backup -> pull -> build idle color -> flip -> health gate)
sh deploy/zero-downtime-deploy.sh

# health check
sh deploy/health-check.sh

# disaster-recovery test (restores the newest dump into a throwaway container)
sh deploy/dr-test.sh

# logs
docker compose -f docker-compose.prod.yml --env-file .env.production logs -f --tail=200 api-a

# manual DB dump (compose-managed Postgres)
sh deploy/backup.sh
```

## Migrating an existing `--scale api=2` install to blue/green

The old topology used replicas `hopedesign-erp-api-1`/`api-2` and `--scale api=2`. To switch a live install:

1. `git pull --ff-only origin main` (on the VPS).
2. Build the new images first - the old stack keeps serving while this runs:
   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production build api-a api-b web
   ```
3. Start the two new colors alongside the old replicas:
   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production up -d --no-deps api-a api-b
   ```
4. Wait for `hopedesign-erp-api-a` to report healthy (`docker ps`), then recreate Caddy so it picks up the new Caddyfile/mounts (one short proxy stop, seconds):
   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production up -d --no-deps --force-recreate caddy
   ```
5. Verify the public endpoint, then remove the old replicas:
   ```bash
   curl -fsS https://hopedesign.jorlentech.com/api/health
   docker rm -f hopedesign-erp-api-1 hopedesign-erp-api-2
   ```
6. From now on deploy **only** with `sh deploy/zero-downtime-deploy.sh`; legacy scripts (`deploy/update.sh`, `deploy/erp-deploy.sh`, `deploy/blue-green-deploy.sh`, ...) were disabled because they target the old topology.

## Layout

| Service | Image target | Role |
|---------|--------------|------|
| `caddy` | caddy:2.8 | TLS termination + atomic flip between the two API colors |
| `web` | Dockerfile `web` | nginx serving the Vite SPA |
| `api-a` / `api-b` | Dockerfile `api` | two API colors; migrations on boot (advisory-locked); only the active color receives traffic |
| `postgres` | postgres:16-alpine | Database (not published) |

The API runtime role is `hopedesign_app` (no superuser, no BYPASSRLS). The owner role `hopedesign` is used only for migrations. The live database is `hopedesign` (809 tables); the legacy host `hopedesign_erp` database is stale and must not be used.

## Production checklist

- `.env.production` is generated, not copied from `.env.example`
- `SEED_ON_BOOT=true` only on an empty database, then set `false` and change `admin` / `ChangeMe!2026`
- First login forces a password of 12+ letters and numbers
- Postgres is not published; only 80/443 are
- `WEB_PUBLIC_URL` and `API_PUBLIC_URL` match the public HTTPS origin (`https://hopedesign.jorlentech.com`)
- AccuWeb Nginx on the host is stopped so Caddy can bind 80/443

## AccuWeb pitfalls

- **SSH on a non-22 port** - this host is **2978**; `vps-setup.sh` opens it in UFW as well as 22.
- **Port 80 already in use** - stop `apache2` / `nginx` / `httpd`.
- **Certificate fails** - the DNS A record must already point at the VPS and UDP/TCP 443 must be open in AccuWeb's network firewall too.
- **Blank page / API 403 CORS** - `WEB_PUBLIC_URL` and `API_PUBLIC_URL` must be the exact public origin (`https://hopedesign.jorlentech.com`, no trailing slash).
- **API exits on boot** - production refuses weak secrets and refuses to run as the owner role.