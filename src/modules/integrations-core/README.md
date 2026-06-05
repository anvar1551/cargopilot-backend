# Integrations Core

This module defines ERP-level integration contracts and execution boundaries.

## Goals

- Keep core ERP modules provider-agnostic.
- Support per-company provider configuration.
- Ensure secure webhook ingestion with idempotency.
- Ensure reliable outbound delivery via outbox + retry + DLQ.

## Layering

- `domain/`: shared integration types and adapter ports.
- `application/`: canonical event model, outbox contracts, provider registry contracts, webhook gateway contracts.
- `transport/`: HTTP/webhook route shape (to be wired in API bootstrap).

## Implementation order

1. Phase 1 complete: DB models + repository contracts/implementations for provider registry, outbox, and webhook event persistence.
2. Phase 2 complete: generic webhook gateway (`/api/integrations/webhooks/:providerCode`) with signature verify + idempotency + raw/canonical persistence.
3. Phase 3 complete: generic integration outbox worker with claim/retry/dead-letter + stale processing reclaim.
4. Phase 4 complete: first carrier + SMS adapters wired into outbox dispatcher.
5. Phase 5 complete: RBAC-protected admin APIs for provider config/secret rotation and outbox monitoring + retry/replay.
6. Add admin UI for provider config, health, retries, DLQ replay.

## Phase 3 runtime behavior

- Worker script: `npm run worker:integration-outbox`.
- Dispatch resolution currently supports `webhook_sink` domain via HTTP endpoint payload/env.
- `carrier` and `sms` now dispatch through HTTP provider adapters using domain-specific env endpoint routing.
- explicit payload action is supported (`create_shipment`, `cancel_shipment`, `track`, `send`, `status`) with event-type fallback mapping.
