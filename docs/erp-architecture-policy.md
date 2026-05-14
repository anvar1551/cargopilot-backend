# CargoPilot ERP Architecture Policy (Locked)

Last updated: 2026-05-14
Scope: backend foundation for CargoPilot growth from parcel flow app to logistics ERP platform.
Status: mandatory engineering policy for all new work.

Related mandatory guardrails:

- `docs/engineering-guardrails.md`

## 1) Locked stack

- Runtime: Node.js 22 LTS
- Language: TypeScript (`strict`)
- API framework: Fastify (REST-first)
- Database (source of truth): PostgreSQL + Prisma
- Realtime/cache/read model: Redis
- Async processing: Outbox + Redis Streams workers
- Realtime transport to UI: SSE (plus Socket where mobile requires it)
- Observability: Pino logs + OpenTelemetry metrics/traces

No framework migration to NestJS in this phase.
No GraphQL in this phase.

## 2) Core architecture contract (One Clean Path)

All features must follow this flow:

1. Command/API validates auth + input.
2. Single DB transaction writes business state.
3. Same transaction writes outbox event.
4. Outbox publisher writes to Redis Stream (`cp:events`).
5. Workers consume events and update Redis projections.
6. Read APIs serve Redis/read-through cache with guarded DB fallback.
7. SSE pushes refresh/delta events to frontend.

Rules:

- Never run heavy aggregation inside SSE controllers.
- Never call third-party integrations inside DB transaction.
- Never return fake zero payloads for normal reads.
- On cache miss, return stale-real or guarded DB fallback result.

## 3) Module boundaries (modular monolith)

Every module has `domain -> application -> infrastructure -> transport`.
Cross-module DB access is forbidden.

Locked bounded contexts:

- `identity-access` (auth, RBAC, policies)
- `organizations` (company/branch/agent/pvz/partner/client hierarchy)
- `orders-legs` (order + multimodal legs)
- `pricing-fx` (multi-currency pricing components + FX snapshots)
- `support` (tickets/case workflow)
- `integrations` (SMS/payments/carriers/partner APIs)
- `documents` (labels/manifests/acts/route sheets)
- `realtime-readmodel` (Redis projections + SSE contracts)

## 4) RBAC + data scope policy

### 4.1 Roles are configurable, permissions are controlled

- Permissions are system-defined codes in backend (for safety and consistency).
- Roles are admin-configurable bundles of permissions.
- Data visibility is separate from permissions and enforced by scope policy.

### 4.2 Required role baseline

- Super Admin
- Company Admin
- Branch Manager
- Agent / PVZ
- Courier
- Client

### 4.3 Required scope behavior

- Agent A cannot see Agent B records.
- PVZ sees only assigned branch/parcels.
- Transport partner sees only own deliveries/legs.
- Client sees only own shipments.
- Finance visibility is role + scope restricted.

Implementation must enforce scope in backend query filters, not only UI.

`AppRole` is not an authorization engine. It may exist only as identity metadata during migration.  
No new endpoint access or row-scope logic may be implemented with `AppRole`.

## 5) Integration layer policy (ERP requirement)

All external systems must be connected through a unified integration layer.

Required classes:

- SMS providers
- Payment providers (Click, Payme)
- Carrier partners
- PVZ/agent partners
- Client-side integrations

Rules:

- Provider adapters implement common interface (`send`, `webhook`, `sync`).
- All inbound webhooks must be idempotent and signed/validated.
- Failures use retry policy + dead-letter path.
- Integration event log is mandatory for audit/debug.
- No direct provider calls from business controllers.

## 6) International and multimodal policy

ERP roadmap requires:

- Warehouse classification: local / foreign with jurisdiction-aware rules.
- Transport modes: road / air / rail.
- Order supports multiple legs (`OrderLeg`) with per-leg statuses/docs/timing.
- Route sheet is document output in this phase (no route optimizer mandatory yet).

## 7) Multi-currency finance policy

Single currency per order is insufficient.

Required model:

- `PricingComponent` entries per order/leg:
  - component type
  - original amount + original currency
  - FX snapshot
  - base/report amount

Rules:

- Original amounts are immutable.
- Consolidation to report currency is deterministic.
- All financial commands are idempotent + audited.

## 8) Performance and reliability SLO targets

- Warm analytics/support reads: p95 <= 400ms
- Cold read-through fallback: p95 <= 1500ms (healthy DB)
- Dashboard updates via SSE without hard page refresh
- No polling loops while SSE is healthy

## 9) Forbidden patterns

- Mixing direct DB-heavy reads with read-model path on the same endpoint
- Per-page custom realtime protocols (must use shared SSE client contract)
- Hidden cross-module service calls bypassing application layer
- Role checks without scope checks for row-level resources
- Any new `AppRole`-based access control logic (`role === ...`) in transport/application layers
- Big-bang rewrites without migration flags

## 10) Delivery and migration strategy

- Strategy: strangler migration in one branch (`codex/erp-foundation`).
- Keep old endpoints behind compatibility flags until new modules pass tests.
- Remove legacy module code only after parity + rollout verification.

## 11) Definition of done (all ERP features)

- Architecture boundary check passes
- API schema + auth + scope checks present
- Transaction + outbox path implemented for commands
- Redis projection + SSE update path implemented for reads
- Idempotency + audit log implemented
- Unit + integration tests pass
- Observability metrics/logs added
