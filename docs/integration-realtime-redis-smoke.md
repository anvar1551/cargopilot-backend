# Realtime + Redis Integration Smoke Tests

These scripts validate end-to-end runtime behavior for analytics/live-map SSE and Redis fallback/recovery.

## Prerequisites

- Backend API running locally (`npm run dev`)
- Database + Redis running
- At least one admin user account exists
- Optional: one dedicated driver account with `drivers.telemetry`

## Environment variables

Required for both scripts:

- `INTEGRATION_ADMIN_EMAIL`
- `INTEGRATION_ADMIN_PASSWORD`

Optional:

- `INTEGRATION_BASE_URL` (default: `http://localhost:4000`)
- `INTEGRATION_DRIVER_EMAIL`
- `INTEGRATION_DRIVER_PASSWORD`

Required for Redis resilience script:

- `REDIS_CONTAINER` (docker container name or id)

## 1) Realtime smoke

Runs:

- `/api/health`
- `/api/analytics/stream` + `/api/analytics/refresh`
- `/api/live-map/stream` + `/api/drivers/telemetry`

Command:

```bash
npm run test:integration:realtime
```

Pass criteria:

- Analytics stream emits `ready`
- Analytics stream emits `analytics-refresh` with `reason=manual_refresh`
- Live-map stream emits `ready`
- Live-map stream emits a `live-map` event for posted telemetry

## 2) Redis resilience smoke

Runs:

- Baseline `/api/health` + `/api/analytics/summary`
- `docker stop $REDIS_CONTAINER`
- Verifies degraded redis health while APIs still respond
- `docker start $REDIS_CONTAINER`
- Verifies redis recovers and APIs still respond

Command:

```bash
npm run test:integration:redis
```

Safety:

- Script has a recovery safeguard to restart Redis if the run fails after stopping it.
