# CargoPilot Engineering Guardrails (Mandatory)

Last updated: 2026-05-14  
Applies to: all backend work in `cargopilot-backend`

## 1) Architecture is locked

All implementation must follow the ERP policy in:

- `docs/erp-architecture-policy.md`

No exceptions without explicit architecture change request.

## 2) No legacy shortcuts for new work

- Do not copy/paste old legacy patterns into new modules.
- Do not reintroduce mixed access logic (old role checks + new RBAC).
- Do not bypass module boundaries for speed.

If a requested change requires violating these rules, stop and raise a warning first.

## 3) RBAC-only authorization and data scope

Authorization and row visibility must be policy-driven:

- permissions from `AccessPermission` / `AccessRole`
- scope from `DataScopePolicy` / org bindings

### Forbidden

- Using `AppRole` for endpoint authorization decisions
- Using `AppRole` for data visibility filters
- Shipping new code that checks `role === ...` for access control

### Allowed transitional use

- `AppRole` may exist only as identity metadata until full migration completes.
- Existing legacy checks must be migrated away; no new ones may be added.

## 4) Command/write policy

Every business command must use:

1. input validation
2. one DB transaction for state changes
3. outbox write in the same transaction
4. async projection update via Redis streams workers

No third-party network calls inside the DB transaction.

## 5) Read/realtime policy

- Read endpoints: Redis/read-through first, guarded DB fallback.
- SSE endpoints: push deltas/invalidation only, no heavy query execution.
- Never return fake zeros for normal reads.

## 6) Developer/agent behavior policy

- If a request conflicts with architecture policy, warn before implementing.
- Prefer clean refactor over quick patch that introduces policy debt.
- Keep communication and code comments in English for engineering consistency.

