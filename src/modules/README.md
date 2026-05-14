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
