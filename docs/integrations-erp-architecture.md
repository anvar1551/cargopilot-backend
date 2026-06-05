# ERP Integration Layer Blueprint

This document defines the target integration layer for CargoPilot ERP and maps it to current code.

## Why this layer exists

Core domains (`orders`, `payments`, `support`, `tracking`) must never depend directly on provider APIs.
The integration layer isolates provider differences, hardens security, and guarantees delivery semantics.

For partner-facing onboarding and API contracts, see `docs/integrations-partner-guide.md`.

## Current state (already in code)

- Payments adapters exist and already follow adapter-style logic in `payments-core`.
- Provider webhooks are handled in payments routes/service.
- Analytics outbox exists for internal realtime invalidation/events.

## Gap to close

- We still need a generic external integration layer for carriers/SMS/partner webhooks.
- Payments should gradually converge to the same generic integration infrastructure where possible.

## Canonical module structure

```txt
src/modules/integrations-core/
  domain/
    types.ts
    ports.ts
  application/
    integration-event.types.ts
    outbox.types.ts
    provider-registry.ts
    webhook-gateway.types.ts
  transport/
    fastify-routes.ts
  index.ts
```

## Contracts defined now

- Shared types: provider status, environment, request context, attempt/result shape.
- Adapter ports:
  - `CarrierAdapter`
  - `SmsAdapter`
  - `WebhookVerifier`
- Canonical integration events:
  - `order.created`, `order.status.changed`, `shipment.assigned`, `shipment.delivered`
  - `payment.intent.created`, `payment.paid`
  - `support.ticket.created`, `sms.delivery.updated`, `carrier.status.updated`
- Outbox contracts:
  - statuses `pending|processing|sent|failed|dead_letter`
  - repository interface for claim/retry/dead-letter
- Provider registry contracts:
  - list/resolve active providers, pause/rotate secret operations
- Webhook gateway contracts:
  - signature verification, idempotency check, raw payload store, canonical event persistence

## Security invariants

1. Every webhook must be signature-verified before state changes.
2. Every webhook event must be idempotent by `(providerCode, providerEventId)`.
3. Secrets must be encrypted at rest and rotatable by key version.
4. Outbound retries must never duplicate business effect without idempotency keys.
5. Integration actions must be RBAC protected (`integration.webhook.manage`, `integration.provider.rotateSecret`).

## Runtime flow (target)

1. Core module emits canonical event to integration outbox.
2. Outbox worker resolves active provider for company + domain.
3. Worker dispatches via adapter with idempotency key.
4. Attempt result is persisted (sent/retry/dead-letter).
5. Inbound provider webhooks enter gateway, are verified, de-duplicated, normalized.
6. Normalized events are applied asynchronously to core modules.

## Phased implementation plan

### Phase 1 - Foundation

- Create DB tables for provider registry, integration outbox, webhook raw events, canonical webhook events, and delivery attempts.
- Implement repository classes for contracts in `application/`.

Status (May 31, 2026):

- Done in codebase:
  - Prisma models + migration `20260531084329_add_integrations_core_phase1`.
  - Repository implementations in `src/modules/integrations-core/infrastructure/`.

### Phase 2 - Webhook gateway

- Add `/api/integrations/webhooks/:providerCode`.
- Verify signature, idempotency, raw store, canonical enqueue.

Status (May 31, 2026):

- Done in codebase:
  - `integrations-core` route registered in API bootstrap.
  - Ingest endpoint implemented at `POST /api/integrations/webhooks/:providerCode`.
  - HMAC SHA-256 signature verification via provider-specific env secret.
  - Idempotency gate by `(providerCode, providerEventId)` with duplicate-safe insert handling.
  - Raw webhook + canonical webhook event persistence through Phase 1 repositories.

Environment keys used by the webhook gateway:

- `INTEGRATION_WEBHOOK_SECRET_<PROVIDER_CODE>` (for example `INTEGRATION_WEBHOOK_SECRET_DHL`)
- `INTEGRATION_WEBHOOK_SECRETS_JSON` (optional map, example `{"dhl":"secret"}`)
- `INTEGRATION_WEBHOOK_SIGNATURE_HEADER` / `INTEGRATION_WEBHOOK_SIGNATURE_HEADER_<PROVIDER_CODE>`
- `INTEGRATION_WEBHOOK_TIMESTAMP_HEADER` / `INTEGRATION_WEBHOOK_TIMESTAMP_HEADER_<PROVIDER_CODE>`
- `INTEGRATION_WEBHOOK_MAX_SKEW_SECONDS` (default `300`)

### Phase 3 - Outbound delivery

- Add integration outbox worker.
- Add retry policy + exponential backoff + DLQ transitions.

Status (May 31, 2026):

- Done in codebase:
  - Dedicated worker loop: `src/workers/integration-outbox.worker.ts`.
  - Publisher engine: claim batch, dispatch, mark sent/retry/dead-letter.
  - Exponential backoff with jitter and configurable caps.
  - Stale `processing` reclaim to avoid permanently stuck outbox rows after worker crash.
  - Best-effort Redis leader lock with DB claim safety fallback.
  - Dispatcher layer introduced; first concrete dispatcher is `webhook_sink` (HTTP endpoint delivery).

Scripts:

- `npm run worker:integration-outbox`
- `npm run start:worker:integration-outbox`

### Phase 4 - Providers

- Carrier adapter V1 (first partner).
- SMS adapter V1 (first provider).
- Payment adapters can progressively reuse shared abstractions.

Status (May 31, 2026):

- Done in codebase:
  - First carrier adapter V1: `HttpCarrierAdapter` (`createShipment`, `cancelShipment`, `track`).
  - First SMS adapter V1: `HttpSmsAdapter` (`send`, `getDeliveryStatus`).
  - Outbox dispatcher now routes `carrier` and `sms` domain records into these adapters.
  - Action resolution supports explicit `payload.action` and event-type fallback mapping.

Environment routing pattern:

- Carrier: `INTEGRATION_CARRIER_BASE_URL_<PROVIDER_CODE>` (+ optional token/api key vars)
- SMS: `INTEGRATION_SMS_BASE_URL_<PROVIDER_CODE>` (+ optional token/api key vars)

### Phase 5 - Admin operations

- UI/API for provider status, credentials rotation, failure replay, DLQ inspection.

## What remains after this blueprint

- Phase 5: admin operations API/UI (provider lifecycle, retry replay, DLQ inspect/replay).
- Load tests and failure drills for webhook + outbox paths.
