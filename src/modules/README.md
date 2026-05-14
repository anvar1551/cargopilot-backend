# Modules (Modular Monolith)

This directory is the target structure for CargoPilot ERP modules.

Rules:
- New cross-cutting business logic goes to `src/modules/<module-name>/`.
- `src/features/*` may keep temporary compatibility wrappers during migration.
- Controllers/services should import module APIs from `src/modules/*`, not from `src/features/*`.
- Each module should expose a small public API through `index.ts`.

Current module foundation:
- `identity-access`: RBAC + scope resolution (`orders`, `support`).
- `orders-legs`: multimodal legs, pricing components, and order document read APIs.
  - folder structure:
    - `legs.ts`: leg list/upsert use-cases + domain events,
    - `pricing.ts`: pricing component ledger lines + domain events,
    - `documents.ts`: generated order documents list queries,
    - `shared.ts`: shared typed inputs and guard helpers.
- `orders-core`: central order runtime use-cases with RBAC scope enforcement:
  - folder structure:
    - `transport/`: HTTP transport layer for `/api/orders` (native Fastify routes + controllers),
    - `read/`: list/get/workload/export queries,
    - `write/`: order creation and write orchestrations,
    - `operations/`: task assignment and cash workflows,
    - `proofs/`: pickup/delivery proof upload + access checks,
    - `import/`: CSV import preview/confirm use-cases,
    - `label/`: label generation queue + worker tick runtime.
    - `shared/`: order actor/error helpers used across order modules.
  - read access (`list`, `getOne`, driver workload, CSV export),
  - create-order flow (address-book save, label workflow, optional invoice/payment),
  - task assignment/status updates with realtime fan-out,
  - cash queue + collect/handoff/settle (single + bulk) with realtime fan-out,
  - pickup/delivery proof upload + proof link retrieval access checks.

Migration note:
- `/api/orders` is now served by native Fastify transport.
- Proof upload endpoints are served by native Fastify routes in `modules/orders-core/transport/fastify-routes.ts`.
