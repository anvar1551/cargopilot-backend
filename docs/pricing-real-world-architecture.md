# CargoPilot Pricing Architecture (Real-World, Transit-Aware)

## Purpose
Define how CargoPilot pricing should evolve from current lane-based quoting to enterprise-grade international pricing while keeping security, auditability, and ERP consistency.

## Current State (Working MVP)
- Quote is selected mainly by:
  - `originCountry`
  - `destinationCountry`
  - `transportMode`
  - weight/zone/rate band
- Result is a single customer-facing service charge (door-to-door).
- System creates operational legs, but pricing is still mostly lane-level.

This is acceptable for early production, but limited for complex cross-border operations.

## Real-World Target Model (DHL-style)
Large carriers generally operate with:
- One customer-visible quote.
- Multiple internal execution legs.
- Leg-level operational costing.
- Surcharges and compliance rules applied on top of base transport.

### Key Principle
Customer billing and operational leg costing must be connected, but not identical.
- Billing quote: what customer pays.
- Leg costs: what operations pays internally/partners.
- Margin: computed from both.

## Transit Countries: How to Model
Two valid patterns:

1. **Implicit transit lane product (Phase 1/2)**
- Example product: `CN -> UZ AIR EXPRESS`.
- Transit countries are hidden inside route template metadata.
- Fast for rollout and simple for UI.

2. **Explicit multi-leg routing (Phase 3+)**
- Example:
  - `CN -> KZ` (export leg)
  - `KZ -> UZ` (linehaul leg)
- Each leg can have its own carrier, SLA, and cost.
- Needed for advanced margin control and network optimization.

Recommendation: start with implicit transit, then evolve to explicit routing.

## Canonical Pricing Flow
1. Resolve shipment context:
   - origin/destination countries
   - service type
   - transport mode
   - chargeable weight/volume
   - currency
2. Select tariff plan and rate band deterministically.
3. Freeze a pricing snapshot on order:
   - plan/rule identifiers
   - charge components
   - currency
   - quoted totals
4. Build execution legs from route template:
   - `pickup -> linehaul -> last_mile` (minimum)
   - include mode/country for each leg
5. Attach payment intent (if online payment) to the same immutable pricing snapshot.
6. Allow ops updates only on execution fields (status, assignment, actual times), not historical quoted price.
7. Emit audit events for every quote/price/payment mutation.

## Pricing Components (Recommended)
Total customer charge should be decomposed into:
- Base transport
- Fuel surcharge
- Remote area surcharge (if any)
- Customs/brokerage handling (if applicable)
- Optional services (insurance, fragile handling, etc.)
- Taxes/fees (jurisdiction-dependent)
- Discount (contract/account)

Store each component for traceability; do not store only a final amount.

## Currency Policy
Supported primary currencies now:
- `USD`
- `UZS`
- `CNY`

Rules:
- Plan defines settlement/display currency.
- Snapshot stores original currency and amount.
- Any conversion must persist `fxRate`, `fxSource`, and `fxTimestamp` used at quote time.
- Never recompute historical orders with new FX rates.

## Security and Integrity Rules
- No client-side price authority: server always recalculates quote.
- Idempotent order + payment creation with idempotency key.
- Webhook-driven payment finalization; never trust frontend success alone.
- Signature verification on all provider callbacks.
- RBAC + scope checks for tariff/payment configuration and override actions.
- Full audit trail for:
  - tariff changes
  - manual repricing
  - payment status transitions

## Data Model Extensions (Planned)
- `tariff_plans`: lane + mode + service profile
- `tariff_rules`: weight/zone/range rates
- `route_templates`: optional transit definition per lane product
- `order_pricing_snapshots`: immutable quote source of truth
- `order_legs`: execution legs with mode/country refs
- `order_leg_costs`: internal/partner cost per leg
- `surcharge_lines`: explicit surcharge decomposition

## Rollout Phases
### Phase 1 (Now)
- Lane-level quoting works for domestic + basic international.
- Immutable order pricing snapshot.
- Basic 3-leg generation.

### Phase 2
- Transit-aware route templates (implicit transit).
- Leg defaults include from/to country and correct linehaul mode.
- Surcharge line decomposition persisted.

### Phase 3
- Explicit multi-leg transit pricing/costing.
- Carrier/vendor rate tables per leg.
- Margin analytics by lane, mode, and carrier.

### Phase 4
- Contract pricing, volume tiers, and SLA penalties.
- Advanced simulation and quote explainability for finance/ops.

## Non-Negotiables
- No hardcoded domestic fallback when international context is resolved.
- No silent currency substitution.
- No mutable historical quote totals without an explicit reprice event.
- No payment status promotion without verified provider/webhook evidence.
