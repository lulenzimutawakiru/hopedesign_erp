# Hope Design ERP on an AccuWeb Linux VPS

Production Docker stack: **Caddy** (HTTPS) → **nginx** (SPA) + **API** (Node 20) + **Postgres 16**.

Ports published on the VPS: **80** and **443** only. Postgres stays on the compose network.

## What you need

- AccuWeb **Linux VPS** (Ubuntu 22.04/24.04 or Debian) with **root SSH**
- At least **2 vCPU / 4 GB RAM / 40 GB disk** (8 GB RAM is more comfortable with Postgres on-box)
- A domain **A record** pointing at the VPS public IP (required for Let's Encrypt)
- Ports **80** and **443** free (disable AccuWeb’s default Apache/nginx if it is bound there)

AccuWeb’s “Docker VPS” image already has Docker CE. A plain Linux VPS does not — `deploy/vps-setup.sh` installs it.

## 1. SSH in and install Docker

```bash
ssh root@YOUR_VPS_IP
# copy this repo onto the VPS, then:
sudo sh deploy/vps-setup.sh
```

The script installs Docker Engine + Compose, enables the daemon, opens UFW for 22/80/443, and stops Apache/nginx if they were occupying port 80.

## 2. DNS

`jorlentech.com` is on Namecheap (`dns1.registrar-servers.com`). Add the ERP host there — **not** on AccuWeb DNS unless you change nameservers.

Namecheap → Domain List → **jorlentech.com** → Advanced DNS:

| Type | Host | Value | TTL |
|------|------|--------|-----|
| A | `hopedesign` | AccuWeb VPS **IPv4** (from the AccuWeb panel; `server.vps-540472.com` is not live yet) | Automatic |

That publishes `hopedesign.jorlentech.com`. Do not point it at `185.158.133.1` (that is the apex `jorlentech.com` site) unless that IP **is** the AccuWeb VPS.

Wait until `ping hopedesign.jorlentech.com` hits the VPS.

For Resend (transactional email), add the domain `hopedesign.jorlentech.com` in the Resend dashboard and copy the SPF/DKIM TXT records Namecheap shows. Sender: `notifications@hopedesign.jorlentech.com`.

## 3. Secrets and compose env

On the VPS, in the repo root:

```bash
# HTTPS (Let's Encrypt) + first-run seed of admin / demo data
node deploy/generate-env.mjs --domain hopedesign.jorlentech.com --email admin@hopedesign.jorlentech.com --seed
```

This writes gitignored `.env.production` with random JWT/DB passwords. Open it and set any mail/SMS keys you need.

HTTP-only smoke test (no certificate):

```bash
node deploy/generate-env.mjs --domain :80 --http --seed --force
```

Then switch to a real hostname and re-generate (or edit `DOMAIN`, `WEB_PUBLIC_URL`, `API_PUBLIC_URL`) before going live.

## 4. Start

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.production ps
curl -fsS https://hopedesign.jorlentech.com/api/health
```

First boot: API waits for Postgres, runs migrations, sets the `hopedesign_app` password, optionally seeds, then serves `/api`. Caddy obtains a Let's Encrypt certificate.

## 5. First login

If you passed `--seed`:

- Username: `admin` (or `admin@hopedesign.co.ug`)
- Password: `ChangeMe!2026`

Change that password immediately. Then set `SEED_ON_BOOT=false` in `.env.production` so later restarts do not re-seed.

```bash
# after editing .env.production
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

## Day-2 operations

```bash
# logs
docker compose -f docker-compose.prod.yml --env-file .env.production logs -f --tail=200

# rebuild after git pull
git pull
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build

# database dump
sh deploy/backup.sh
```

Uploads live in the `uploads` volume; Postgres in `pgdata`; certificates in `caddy_data`.

## Layout

| Service  | Image target | Role |
|----------|--------------|------|
| `caddy`  | caddy:2.8    | TLS termination, `/api` → API, everything else → web |
| `web`    | Dockerfile `web` | nginx serving the Vite SPA |
| `api`    | Dockerfile `api` | Express API, migrations on boot |
| `postgres` | postgres:16-alpine | Database (not published) |

The API runtime role is `hopedesign_app` (no superuser, no BYPASSRLS). The owner role `hopedesign` is used only for migrations.

## Production checklist

- `.env.production` is generated, not copied from `.env.example`
- `SEED_ON_BOOT=true` only on an empty database, then set `false` and change `admin` / `ChangeMe!2026`
- First login forces a password of 12+ letters and numbers
- Postgres is not published; only 80/443 are
- `WEB_PUBLIC_URL` and `API_PUBLIC_URL` match the public HTTPS origin (`https://hopedesign.jorlentech.com`)
- AccuWeb Nginx on the host is stopped so Caddy can bind 80/443

## AccuWeb pitfalls

- **Port 80 already in use** — stop `apache2` / `nginx` / `httpd` (the setup script tries this).
- **Certificate fails** — DNS A record must already point at this VPS; UDP/TCP 443 must be open in AccuWeb’s network firewall as well as UFW.
- **Blank page / API 403 CORS** — `WEB_PUBLIC_URL` and `API_PUBLIC_URL` must be the exact public origin (`https://hopedesign.jorlentech.com`, no trailing slash).
- **API exits on boot** — production refuses weak secrets and refuses to run as the owner role. Use `generate-env.mjs`; do not copy `.env.example` into production.
- **cPanel / managed VPS** — this stack needs a raw Linux VPS with root, not a shared-hosting account.
