# Orders Service Architecture

This module is split by responsibility to keep changes isolated and easier to review.

## Folder structure

- `controller/`: HTTP handlers only (request validation, response shape).
- `workflow/`: business rules and state transitions.
- `repo/`: database persistence and query logic.
- `orderService.shared.ts`: shared actor/error utilities.

## Main entry points

- Controllers:
  - `controller/create.controller.ts`
  - `controller/read.controller.ts`
  - `controller/tasks.controller.ts`
  - `controller/index.ts`
- Workflows:
  - `workflow/task/order-task.workflow.ts`
  - `workflow/index.ts`
- Repos:
  - `repo/order-write.repo.ts`
  - `repo/order-read.repo.ts`
  - `repo/index.ts`

## Compatibility facades

These files are intentionally kept as facades for backward compatibility:

- `orderController.ts` -> re-exports from `controller/`
- `orderRepo.prisma.ts` -> re-exports from `repo/`

Use the folder indexes (`controller`, `workflow`, `repo`) for all new imports.

## Design rules

1. Controller layer should not contain workflow logic.
2. Workflow layer should not build HTTP responses.
3. Repo layer should not enforce role-based business policy.
4. Shared auth actor parsing should use `requireOrderActor(...)`.
5. Business errors should use `orderError(...)` for consistent status handling.
6. Runtime operations are split cleanly: driver assignment + explicit status updates.
7. Manager can apply any status; warehouse has restricted status policy.

## Scaling notes

- List endpoints support `mode=cursor` with `nextCursor` for high-cardinality paging.
- Search defaults to `scope=fast` (index-friendly fields). Use `scope=deep` only when you need relational text matching.
- Default list payload is intentionally lightweight; use detail endpoint for full tracking history.
- Bulk write endpoints now default to compact response payloads. Add `?include=full` when full hydrated records are explicitly required.
- Bulk write operations are hard-capped server-side with `ORDER_BULK_MAX_IDS` (default `100`).
- Driver workload aggregation is available via `GET /api/orders/driver-workloads` (manager/warehouse).
- Task operations API:
  - `POST /api/orders/assign-driver-bulk`
  - `POST /api/orders/tasks/assign-bulk`
  - `POST /api/orders/status-bulk`
- `POST /api/orders/tasks/assign-bulk` is backward-compatible alias to direct assign flow.
- `POST /api/orders/status-bulk` expects `status` and optional `reasonCode/note/region/warehouseId`.
- Label generation mode is controlled by env:
  - `ORDER_LABEL_MODE=sync` (default)
  - `ORDER_LABEL_MODE=async` (faster create response, labels generated in background)
  - `ORDER_LABEL_MODE=queue` (durable DB queue, processed by label worker)
- Label worker runtime controls:
  - `ORDER_LABEL_WORKER_POLL_MS` (default `2000`)
  - `ORDER_LABEL_WORKER_BATCH_SIZE` (default `10`)
  - `ORDER_LABEL_MAX_ATTEMPTS` (default `5`)
  - `ORDER_LABEL_RETRY_BASE_MS` (default `15000`)
  - `ORDER_LABEL_RETRY_CAP_MS` (default `300000`)
- Tracking retention/partition runbook:
  - `docs/tracking-retention-runbook.md`
  - `scripts/tracking-retention.sql`
- Read-load test entrypoint:
  - `npm run load:orders:read` (requires k6 installed)
