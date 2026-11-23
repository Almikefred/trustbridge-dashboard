# Deployment (Vercel)

Deploy TrustBridge Dashboard to Vercel with PostgreSQL.

← Back to [README](../README.md) · See also [Environment variables](./ENVIRONMENT.md)

---

## Overview

| Component | Recommended hosting |
|-----------|---------------------|
| Next.js web app | Vercel project (auto-build) or Node server |
| Durable Queue Worker | Separate persistent process (Railway, Fly.io, Render, VM/Docker, systemd) |
| PostgreSQL | Vercel Postgres, Neon, Supabase, or self-hosted |
| Auth | GitHub OAuth (external) |
| Stellar data | Horizon API (external) |

---

## Worker process topology

The dashboard is **not** a single process. Production needs three distinct
process roles running side by side. Missing any one of them fails silently —
the web app keeps serving, but Wave sync and scheduled exports quietly stop.

| Process | What it runs | Responsibility | Required in prod |
|---------|--------------|----------------|------------------|
| **web** | `next start` (Vercel or Node) | Serves UI + API routes, enqueues outbox rows, exposes health/metrics | Yes |
| **outbox worker** | `src/lib/soroban-outbox-worker.ts` | Drains the Soroban outbox: polls pending rows, submits to Soroban RPC, advances the cursor | Yes |
| **cron / export scheduler** | Platform cron (Vercel Cron, systemd timer, k8s CronJob) | Triggers scheduled Wave exports and periodic maintenance; takes the export lock | Yes (if scheduled exports are enabled) |

```
            ┌──────────────┐   enqueue    ┌──────────────┐
  users ───▶│  web (Next)  │─────────────▶│  PostgreSQL  │
            └──────┬───────┘              │  outbox rows │
                   │ health/metrics       └──────┬───────┘
                   ▼                             │ poll
            ┌──────────────┐                     ▼
            │  Prometheus  │◀── metrics ──┌──────────────┐
            └──────────────┘              │ outbox worker│
                                          └──────────────┘
            ┌──────────────┐   export lock
            │ cron/export  │─────────────▶ PostgreSQL
            └──────────────┘
```

The web process **enqueues** outbox work; it never drains it. The outbox worker
is the only process that submits Soroban transactions. The cron scheduler is the
only process that fires scheduled exports. Do not fold these into the web
process — serverless request lifetimes are too short to drain a backlog.

---

## Health probes per process

Each process needs its own liveness and readiness probe. A failing probe means
that specific role is down — not that the whole deployment is broken.

| Process | Liveness | Readiness | Interval | Failing probe means |
|---------|----------|-----------|----------|---------------------|
| **web** | `GET /api/health` → `200` | `GET /api/health` → `200` and DB reachable | 30s | Web is down or DB unreachable; users see errors |
| **outbox worker** | Process alive (supervisor heartbeat) | Last successful poll within `OUTBOX_POLL_INTERVAL_MS × 3` | 30s | Outbox backlog grows; Wave sync stalls |
| **cron / export** | Timer registered (systemd/`vercel cron`) | Last run completed within 2× schedule interval | per schedule | Scheduled exports missed; export lock may be stale |

For the outbox worker, readiness is derived from cursor lag: if the newest
pending outbox row is older than three poll intervals, the worker is not
keeping up and should be restarted or scaled.

---

## Environment variables per process

All processes share `DATABASE_URL`. The table below lists what each role
additionally needs. Names match [ENVIRONMENT.md](./ENVIRONMENT.md) and
`.env.example`.

| Variable | web | outbox worker | cron/export | Notes |
|----------|-----|---------------|-------------|-------|
| `DATABASE_URL` | ✓ | ✓ | ✓ | Required by all |
| `SOROBAN_RPC_URL` | ✓ | ✓ | — | Worker submits here |
| `SOROBAN_NETWORK_PASSPHRASE` | ✓ | ✓ | — | Must match RPC network |
| `SOROBAN_CONTRACT_ID` | ✓ | ✓ | — | Outbox target contract |
| `OUTBOX_POLL_INTERVAL_MS` | — | ✓ | — | Optional; default poll cadence |
| `OUTBOX_BATCH_SIZE` | — | ✓ | — | Optional; rows drained per poll |
| `CRON_EXPORT_LOCK_TTL_MS` | — | — | ✓ | Optional; export lock staleness window |
| `METRICS_SCRAPE_TOKEN` | ✓ | — | — | Required in prod for `/api/metrics/prometheus` |

Optional variables fall back to documented defaults; set them explicitly when
you need to tune cadence or lock behaviour.

---

## Failure modes when a worker is missing

These failures are **silent** — the web app stays healthy while work piles up.
Watch for each signal:

| Missing process | Symptom | How to detect |
|-----------------|---------|---------------|
| **outbox worker** | Outbox backlog grows unbounded; Wave sync stalls | Pending outbox row count rising; cursor lag > 3× poll interval |
| **cron / export** | Scheduled Wave exports never fire | No export run within 2× schedule interval; export lock older than `CRON_EXPORT_LOCK_TTL_MS` |
| **web** | Enqueue stops; API 5xx | `/api/health` non-200; error-rate alert |

Detection queries (run against production `DATABASE_URL`):

```sql
-- Outbox backlog and cursor lag
SELECT count(*) AS pending,
       now() - min(created_at) AS oldest_pending_age
FROM soroban_outbox
WHERE status = 'pending';

-- Stale export lock
SELECT * FROM export_lock
WHERE acquired_at < now() - interval '1 hour';
```

If `oldest_pending_age` exceeds three poll intervals, the outbox worker is down
or wedged. If the export lock is older than its TTL, the cron scheduler is not
running or crashed mid-run. Restart the affected process; the outbox worker is
idempotent and will resume from the cursor without duplicating submissions.

---

## Pre-deployment checklist

- [ ] GitHub repo pushed to GitHub
- [ ] Production PostgreSQL provisioned
- [ ] GitHub OAuth App created for production domain
- [ ] All env vars documented in [ENVIRONMENT.md](./ENVIRONMENT.md)
- [ ] Durable worker process host/supervisor provisioned (PM2, systemd, Docker, or PaaS worker)
- [ ] Outbox worker process running with liveness + readiness probes
- [ ] Cron/export scheduler registered with its own probe
- [ ] `METRICS_SCRAPE_TOKEN` set for production (see [Prometheus metrics](#prometheus-metrics-scrape-auth))

---

## Step 1: Import to Vercel

1. Go to [vercel.com/new](https://vercel.com/new)
2. Import `trustbridge-dashboard` repository
3. Framework preset: **Next.js** (auto-detected)
4. Build command: `npm run build` (default)
5. Output: default

---

## Step 2: Environment variables

Add in Vercel → Settings → Environment Variables:

```
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
NEXTAUTH_URL=https://your-project.vercel.app
NEXTAUTH_SECRET
GITHUB_MAINTAINER_ORG
DATABASE_URL
NEXT_PUBLIC_HORIZON_URL=https://horizon.stellar.org
NEXT_PUBLIC_DEFAULT_ASSET_CODE=USDC
NEXT_PUBLIC_DEFAULT_ASSET_ISSUER=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
NEXT_PUBLIC_MIN_XLM_BALANCE=1.5
NEXT_PUBLIC_BASE_RESERVE_XLM=0.5
SOROBAN_RPC_URL=https://mainnet.sorobanrpc.com
SOROBAN_NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
SOROBAN_CONTRACT_ID=

NEXT_PUBLIC_MIN_XLM_BALANCE=1
METRICS_SCRAPE_TOKEN=<random-32+-byte-secret>
```

`SOROBAN_RPC_URL`, `SOROBAN_NETWORK_PASSPHRASE`, and `SOROBAN_CONTRACT_ID` are
optional individually, but the network panel warns when the Horizon and Soroban
URLs classify as two different known networks. The dashboard's network
configuration is read-only; use the
[network switching checklist](./ENVIRONMENT.md#network-switching-checklist) and
rebuild after changing any `NEXT_PUBLIC_*` value.

Deploy once, then update `NEXTAUTH_URL` if using a custom domain. For exact
user-visible error messages and recovery steps, link
[Troubleshooting](./TROUBLESHOOTING.md) from your operations runbook.

---

## Step 3: Database migration

From your local machine with production `DATABASE_URL`:

```bash
DATABASE_URL="postgresql://..." npm run db:push
```

Or use Prisma Migrate for versioned migrations:

```bash
DATABASE_URL="postgresql://..." npx prisma migrate deploy
```

---

## Step 4: GitHub OAuth production app

Update or create OAuth App:

| Field | Value |
|-------|-------|
| Homepage URL | `https://your-domain.vercel.app` |
| Callback URL | `https://your-domain.vercel.app/api/auth/callback/github` |

---

## Step 5: Verify production

| Test | URL |
|------|-----|
| Landing | `/` |
| OAuth sign-in | CTA → GitHub → `/register` |
| Registration | Enter G-address, save |
| Dashboard | `/dashboard` (maintainer org member) |
| API health | `POST /api/check` with `{ "address": "G..." }` |
| Prometheus scrape | `GET /api/metrics/prometheus` with `Authorization: Bearer $METRICS_SCRAPE_TOKEN` |

---

## Custom domain

1. Vercel → Domains → add domain
2. Update `NEXTAUTH_URL` to custom domain
3. Update GitHub OAuth callback URL
4. Redeploy

---

## Prometheus metrics scrape auth

`GET /api/metrics/prometheus` exposes Wave volume, payout readiness, and
internal labels. It is **not** world-readable in production: the route requires
a scrape token and returns `401` with a stable reason code when the token is
missing or wrong, and `503` when no token is configured in production.

### Configure the token

Set **`METRICS_SCRAPE_TOKEN`** to a high-entropy secret (32+ random bytes, e.g.
`openssl rand -hex 32`). It is compared with constant-time equality, so the
length and content of a wrong token do not leak through timing.

```bash
# Vercel
vercel env add METRICS_SCRAPE_TOKEN production

# Self-hosted / Docker
METRICS_SCRAPE_TOKEN="$(openssl rand -hex 32)"
```

### Scrape configuration

Prometheus must send the token as a bearer credential. Do **not** put the token
in the URL — it would land in access logs and referrers.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: trustbridge
    metrics_path: /api/metrics/prometheus
    scheme: https
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/trustbridge-scrape-token
    static_configs:
      - targets: ["your-domain.vercel.app"]
```

### Network policy / reverse proxy

Defence in depth — restrict the route at the edge as well as with the token:

- **Vercel**: put `/api/metrics/prometheus` behind a WAF/rewrite rule that only
  allows your scraper's egress IPs, or front the app with a reverse proxy that
  enforces an IP allowlist.
- **Self-hosted**: add an `allow`/`deny` block in nginx for the metrics path and
  keep the token check as the second layer.

### Token rotation

1. Generate a new token (`openssl rand -hex 32`).
2. Update `METRICS_SCRAPE_TOKEN` in the platform env and redeploy.
3. Update the scraper's `credentials_file` and reload Prometheus.

Rotate on a schedule and immediately on suspected exposure. Because the check
is a single env var, rotation is atomic — there is no dual-token window, so
briefly expect `401`s until the scraper is updated.

### Cardinality limits

The Prometheus payload is bounded to keep scrape cost and storage predictable:

- Labels are drawn from a fixed set (route, status, outcome); no wallet
  addresses, GitHub usernames, or free-form input are used as label values.
- Per-series cardinality is capped; excess series are dropped rather than
  emitted, so a burst of distinct inputs cannot blow up the TSDB.
- If you need higher cardinality, raise the cap deliberately and watch
  `prometheus_tsdb_head_series` after the change.

### Failure reason codes

| Status | Reason | Meaning |
|--------|--------|---------|
| `401` | `metrics_unauthorized` | Token missing or does not match |
| `503` | `metrics_token_not_configured` | Production without `METRICS_SCRAPE_TOKEN` |

---

## Backup and restore drill (Docker Compose)

Use the same Postgres container defined in [DOCKER_COMPOSE.md](./DOCKER_COMPOSE.md) for a local recovery drill. This is a write-up, not a production substitute for automated backups.

### 1) Create a dump

```bash
docker-compose exec postgres pg_dump -U trustbridge -d trustbridge_dashboard --format=custom --file=/tmp/trustbridge_dashboard.pg_dump
```

### 2) Copy the dump off the container

```bash
docker cp trustbridge-postgres:/tmp/trustbridge_dashboard.pg_dump ./artifacts/trustbridge_dashboard.pg_dump
```

### 3) Restore into a fresh database

```bash
docker-compose exec postgres createdb -U trustbridge trustbridge_dashboard

docker cp ./artifacts/trustbridge_dashboard.pg_dump trustbridge-postgres:/tmp/trustbridge_dashboard.pg_dump
docker-compose exec postgres pg_restore --clean --if-exists -U trustbridge -d trustbridge_dashboard /tmp/trustbridge_dashboard.pg_dump
```

### 4) Re-run migrations after restore

```bash
DATABASE_URL="postgresql://trustbridge:trustbridge-dev-password@localhost:5432/trustbridge_dashboard?schema=public" npm run db:deploy
```

> Never commit dump files or leave them in a shared working tree. These dumps may contain GitHub usernames, wallet addresses, registration history, and other personal data. Use encrypted storage or a managed backup service for production.

## Monitoring & limits

- **Grafana Dashboards & Metrics** — import ready-made dashboards in [docs/grafana/](./grafana/README.md) ([Overview JSON](./grafana/trustbridge-overview.json) / [JSON API JSON](./grafana/trustbridge-json-api.json)) for live payout readiness, outbox backlog, and worker health panels.
- **Outbox worker** — alert when pending outbox rows exceed your backlog threshold or cursor lag exceeds three poll intervals (see [Failure modes](#failure-modes-when-a-worker-is-missing)).
- **Cron/export** — alert when no export run completes within 2× the schedule interval, or when the export lock is older than `CRON_EXPORT_LOCK_TTL_MS`.
