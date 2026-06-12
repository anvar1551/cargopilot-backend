# Production Workers and Route Security

## Required runtime processes

CargoPilot is not a single-process ERP. In production, run these processes from the same build artifact.

| Process | Command | Required | Owns |
| --- | --- | --- | --- |
| API | `node dist/src/index.js` | Yes | HTTP API, auth, webhooks, SSE, synchronous requests. |
| Analytics outbox worker | `node dist/src/workers/analytics-outbox.worker.js` | Yes | Moves domain events into analytics/realtime read models. |
| Integration outbox worker | `node dist/src/workers/integration-outbox.worker.js` | Yes | Dispatches carrier/SMS/webhook integrations, retries, canonical result processing. |
| Label worker | `node dist/src/workers/order-label.worker.js` | Yes | Generates order labels asynchronously. |

Development shortcut:

```powershell
npm run dev:stack
```

Development with fake carrier:

```powershell
npm run dev:stack:fake
```

## Worker rules

- Run exactly one API web service per deployed web instance.
- Run at least one instance of each required worker.
- Keep `INTEGRATION_OUTBOX_IN_API=false` in production.
- Keep `ANALYTICS_WORKER_IN_PROCESS=false` in production.
- Workers must share the same `DATABASE_URL`, `REDIS_URL`, `REDIS_PREFIX`, and encryption master keys as the API.
- Label worker also needs S3 env vars when labels/proofs are stored in S3.

## Route security audit result

Audit date: 2026-06-12.

All business/data routes are protected by `fastifyAuth` with explicit permissions, except the intentionally public endpoints below.

Public endpoints:

- `GET /api/health`
- `POST /api/users/register`
- `POST /api/users/login`
- `POST /api/users/refresh`
- `POST /api/users/logout`
- Payment callbacks:
  - `POST /api/payments/click/callback`
  - `POST /api/payments/payme/callback`
  - `POST /api/payments/uzum/callback`
  - Stripe callback route
- Integration webhooks:
  - `POST /api/integrations/webhooks/:providerCode`

Auth-only user-owned endpoints:

- `GET /api/users/me`
- `POST /api/users/change-password`
- Notification endpoints. These operate on the authenticated user and also enforce notification access in the handler.

Explicitly secured operational endpoints:

- Live map snapshot/stream require `shipment.view`.
- Driver telemetry/presence routes require either `drivers.telemetry` or `drivers.manage`.
- Carrier booking/sync/cancel require `shipment.bookCarrier`.
- Integration provider/routing/outbox/event monitoring routes require integration permissions.
- Cash settlement requires `finance.settleCash`.

## Pre-publish smoke checklist

Run after deploying API and all workers:

1. `GET /api/health` returns `ok`.
2. Login as super admin.
3. Open Users page and verify permissions/roles load.
4. Create a test order.
5. Confirm pricing is applied.
6. Confirm label job completes.
7. If fake carrier is configured, confirm carrier auto-book creates an outbox event and leg booking status updates.
8. Open `Integrations -> Event Inbox` and verify webhook/canonical events are visible.
9. Open Analytics and verify finance queue loads without Redis or cash settlement errors.
10. Open Live Map and verify stream connects.

## Failure ownership

- Order created but analytics stale: check analytics outbox worker logs.
- Carrier booking stuck pending: check integration outbox worker logs and `Integrations -> Delivery Queue`.
- Carrier webhook received but order leg not updated: check `Integrations -> Event Inbox`.
- Label missing: check label worker logs and order label job state.
- Payment paid at provider but pending in CargoPilot: check payment callback URL, provider webhook secret, and payment sync/retry button.
