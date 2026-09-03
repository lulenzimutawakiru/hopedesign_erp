# Hope Design Group Ltd - Enterprise ERP

Integrated ERP for a paper manufacturing and security-printing company: CRM to Sales to Demand to MRP to Procurement to Receiving to QC to Inventory to Manufacturing to Finished Goods to QR Traceability to Warehouse to Dispatch to Invoice to Payment to Finance to Analytics.

## Stack
- **API**: Node.js + TypeScript + Express, PostgreSQL (raw SQL + migrations), JWT + TOTP MFA, RBAC + ABAC, SoD, workflow engine.
- **Web**: React + Vite + TypeScript, enterprise shell with global search, QR scanner, approvals, notifications.
- **Infra**: Docker Compose (PostgreSQL 16 + Redis 7), local object storage for documents.

## Quickstart
```bash
docker compose up -d
npm install
cp .env.example .env
npm run db:migrate
npm run db:seed
npm run dev:api   # http://localhost:4000
npm run dev:web   # http://localhost:5173
```

Default seeded super admin: username `admin` (or `admin@hopedesign.co.ug`) / `ChangeMe!2026`

## Production (AccuWeb Linux VPS)

Docker Compose stack with Caddy (Let’s Encrypt), nginx SPA, API, and Postgres. See **[deploy/README.md](deploy/README.md)**.

```bash
sudo sh deploy/vps-setup.sh
node deploy/generate-env.mjs --domain erp.yourdomain.com --email admin@yourdomain.com --seed
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

First login after seed: `admin` / `ChangeMe!2026`, then the app requires a new 12-character password. Set `SEED_ON_BOOT=false` afterwards. Details in **[deploy/README.md](deploy/README.md)**.

## Tests
```bash
npm test
```

## Ream authenticity, public verification & Niimbot printing

Every ream is minted with its own unique, unforgeable QR (`code|secret` payload -
only the SHA-256 hash of the secret is stored). When a carton is packed, the 5
ream QRs are scanned on the packing line; sealing the carton mints a **carton QR**
that links all 5 reams. Anyone can verify a label at the public portal
**`/verify`** (no login required) - reams and cartons report `AUTHENTIC` /
`ALREADY_VERIFIED`, and a carton QR lists the 5 reams packed inside it.

### Workflow
1. **Generate ream QRs** - `Security > Ream Packing` (or `POST /api/qr/reams/generate`).
2. **Print ream labels** - spool labels to the Niimbot queue (`POST /api/qr/labels/spool`),
   then print in the browser over Bluetooth or USB (or with the bridge daemon).
3. **Pack** - scan each ream QR on the packing line (`POST /api/qr/packing/scan`).
4. **Seal** - after 5 reams, seal the carton (`POST /api/qr/packing/seal`); a unique
   carton QR is minted and linked to the 5 reams.
5. **Verify** - end users scan any label and visit `/verify`, or hit
   `POST /api/public/verify` with the payload.

### API endpoints
- `POST /api/qr/reams/generate` - mint N unique ream QRs for a REAM product.
- `GET  /api/qr/reams/:code` - ream details by QR code.
- `GET  /api/qr/cartons/:code` - carton details + member reams by QR code.
- `POST /api/qr/packing/scan` - scan a ream QR on the packing line.
- `POST /api/qr/packing/seal` - seal 5 scanned reams into one carton.
- `POST /api/qr/labels/spool` - queue ream/carton labels for the Niimbot.
- `GET  /api/qr/labels/spool` - bridge polling endpoint (queued labels + PNGs).
- `POST /api/qr/labels/:id/printed` / `.../:id/failed` - bridge acknowledgements.
- `POST /api/public/verify` - unauthenticated public verification.

### Niimbot printing
Labels are rendered server-side as PNGs (ream 40x25mm, carton 60x40mm) under
`STORAGE_ROOT/niimbot/...`.

**Browser printing (primary).** Spool labels from `Security > Ream Packing`, then
click **Print via Bluetooth (Niimbot)** or **Print via USB (Niimbot)** on the spool
card. The page uses the vendored `niimbot-web-bluetooth` driver
(`apps/web/public/vendor/niimbot.js`) over Web Bluetooth and a Web Serial driver
(`apps/web/public/vendor/niimbot-serial.js`) over USB. Both transports open the
browser's native device chooser (also available standalone under **Niimbot printer
discovery** on the same page), auto-detect the printer model, render each label at
the detected printer's DPI, print, then acknowledge each label server-side
(`/printed`, or `/failed` with the reason). Requirements: Chrome or Edge over HTTPS
(localhost works) - Bluetooth needs Web Bluetooth and the Niimbot powered on nearby,
USB needs Web Serial and the Niimbot plugged in. Firefox and Safari fall back to the
bridge daemon below. Label pixel size is derived from the physical label size and the
detected printer DPI.

**Bridge daemon (fallback).** A thin bridge daemon polls the spool queue and
drives the printer:

```bash
NIIMBOT_ENABLED=true NIIMBOT_BRIDGE_URL=http://<printer-bridge>:8188 \
  API_BASE_URL=http://localhost:4000 \
  PRINTER_USERNAME=admin PRINTER_PASSWORD='ChangeMe!2026' \
  npm run niimbot:bridge -w apps/api
```

The bridge logs in, polls `GET /api/qr/labels/spool`, POSTs each PNG (base64) to
`NIIMBOT_BRIDGE_URL/print` as `{ imageBase64, mac }`, then acknowledges the label
via `/printed` (or `/failed` with the reason). Point `NIIMBOT_BRIDGE_URL` at any
Niimbot LAN/BLE bridge that accepts that JSON body, and set `NIIMBOT_MAC` for
BLE-based bridges. Labels remain queued until a bridge prints and acknowledges
them.
