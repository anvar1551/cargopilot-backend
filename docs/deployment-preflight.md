# CargoPilot Deployment Preflight

Use this checklist before publishing a demo/staging build.

## Required Backend Services

The backend production stack must run these processes:

- `api`: `node dist/src/index.js`
- `label-worker`: `node dist/src/workers/order-label.worker.js`
- `analytics-worker`: `node dist/src/workers/analytics.worker.js`
- `analytics-outbox-worker`: `node dist/src/workers/analytics-outbox.worker.js`
- `integration-outbox-worker`: `node dist/src/workers/integration-outbox.worker.js`
- `finance-posting-worker`: `node dist/src/workers/finance-posting.worker.js`
- `finance-outbox-worker`: `node dist/src/workers/finance-outbox.worker.js`
- `redis`
- `postgres` or external PostgreSQL/Neon/RDS

The API also starts lightweight in-process maintenance loops:

- notification retention
- support retention
- support rules worker
- support SLA monitor
- analytics invalidation consumer
- analytics warmup loop

## Required Server Env

Use `.env.production.example` as the clean production template.

Critical stable secrets:

- `JWT_SECRET`
- `REFRESH_TOKEN_SECRET`
- `PAYMENT_CONFIG_MASTER_KEY`
- `INTEGRATION_CONFIG_MASTER_KEY`

Do not casually rotate `PAYMENT_CONFIG_MASTER_KEY` or `INTEGRATION_CONFIG_MASTER_KEY`; encrypted provider credentials in the database depend on them.

First owner bootstrap env:

- `ERP_OWNER_EMAIL`
- `ERP_OWNER_PASSWORD`
- `ERP_OWNER_NAME`

Use a temporary strong password for first deploy, login once, then rotate it from the UI/database process.

## Network Exposure

Production compose defaults bind backend, frontend, Redis, and Postgres ports to `127.0.0.1`.

Recommended public exposure:

- `https://api.example.com` -> reverse proxy to `127.0.0.1:4000`
- `https://app.example.com` -> reverse proxy to `127.0.0.1:3000`

Do not expose Redis or Postgres publicly. If you intentionally need public API/frontend ports without a reverse proxy, set:

```env
API_BIND=0.0.0.0
FRONTEND_BIND=0.0.0.0
```

Only do that behind a firewall/security group.

## Payment Provider Configuration

Provider credentials are configured in the admin UI, not as normal env variables:

- Billing & Pricing -> Payment Providers
- For Stripe:
  - secret key: `sk_live_...` or test key for staging
  - service/webhook secret: `whsec_...`
  - status: active
  - environment: sandbox or production

Production Stripe webhook endpoint:

```txt
https://YOUR_API_DOMAIN/api/payments/stripe/callback
```

Stripe events to enable for the current flow:

- `checkout.session.completed`
- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `charge.refunded` or `payment_intent.canceled` when refund/cancel flows are used

The endpoint must be reachable from the public internet over HTTPS. Ngrok is only for local development.

## Deploy Commands

Backend:

```bash
cp .env.production.example .env.docker
# edit .env.docker with production secrets and URLs
docker compose --env-file .env.docker up -d --build
docker compose --env-file .env.docker ps
docker compose --env-file .env.docker logs -f api
```

Post-deploy bootstrap for a fresh database:

```bash
docker compose --env-file .env.docker exec api node dist/src/scripts/seed-permissions.js
docker compose --env-file .env.docker exec api node dist/src/scripts/bootstrap-erp-access.js
docker compose --env-file .env.docker exec api node dist/src/scripts/bootstrap-support.js
```

Frontend:

```bash
cp .env.production.example .env
# edit .env with public production URLs/tokens
docker compose --env-file .env up -d --build
docker compose --env-file .env ps
docker compose --env-file .env logs -f frontend
```

## Smoke Checks

Backend:

```bash
curl https://YOUR_API_DOMAIN/api/health
```

Admin UI:

- login as super admin
- create/list orders
- open order detail
- create Stripe test payment in staging
- verify Stripe webhook updates payment state
- verify analytics page shows SSE live
- verify live map loads
- verify support page loads queues/tickets

Workers:

- create an order and confirm label worker generates label
- create route/carrier test in staging and confirm integration outbox worker processes it
- refresh analytics and confirm outbox/analytics workers do not log Redis timeout loops
- confirm finance source events are posted or visible in `/api/finance/exceptions`

## Push Safety

Before committing:

- Do not stage local `.env`, `.env.docker`, `.env.local`
- Do not stage temporary Office lock files such as `~$*.docx`
- Do not stage generated `dist/` unless this deployment strategy intentionally tracks compiled output
- Do stage schema/migrations/source/Docker/env example/docs changes
