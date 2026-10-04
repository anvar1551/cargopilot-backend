# Connected synthetic backend journey — 2026-10-04

Baseline d556456c97314866c0b8adbb497c532192e93696. This finite batch adds a connected service-level PostgreSQL regression and documentation; application source, schema, dependencies and API behavior are unchanged. It does not establish a completed delivery journey or production readiness.

## Bounded execution plan and prerequisites

Use the existing owned disposable runner and current 111 migrations. Provision only synthetic tenants, company/branch and financial legal-entity configuration, identities, active membership bridges and explicit company-scoped grants. The passive fixture persistence adapter receives empty warehouse/customer/address/order/invoice arrays. Assert zero orders/customers before exercising the real services; never insert an order directly.

Use four separate identities: fixture finance maker and checker, the explicitly selected TransAsia Uzbekistan operator membership, and a new synthetic local driver with its own tenant/company memberships. Proposal and approval are independent; driver execution never impersonates the operator. Each business entrypoint reloads current authorization from the real database. No login/JWT/HTTP transport is claimed by this service-level test.

Run real master creation, immutable configuration publication, normal creation, payer/price acceptance, supported pickup transitions, proof and invoice issuance. Retain the original request identities and content for all supported retries. Assert complete captured business state is unchanged after rejected onward transitions and matching retries. Preserve unsupported transitions instead of inventing policy. No migration or rollback change is needed; the test only runs in an exclusively owned disposable database.

## Observed connected behavior

| Step / actual entrypoint | Observed result |
|---|---|
| `createCustomerEntity` / `createAddress` | Two tenant-owned customers (shipment master and independently instructed payer), two structured ZZ city addresses belonging to the shipment customer, created through scoped services. |
| `createTariffPlan` / `proposeTariffVersion` / `decideTariffVersion` | Real draft authoring and independently approved immutable bucket tariff, UZS 100. Draft/operational estimate fields do not establish accepted financial authority. |
| `proposeBillingPolicy` / `decideBillingPolicy` | Independently approved explicit synthetic policy: zone 1, recorded kilograms, HALF_EVEN precision 2, packing 0.01, synthetic exclusive 10% tax, manual billing eligible at `pending` and `picked_up`. These are test settings, not TransAsia business/tax policy. |
| `createOrderForActor` | One normal pending order, original UUID operation identity, authoritative tenant/owning company and master/address references; no direct order insert. Manual `OTHER` payment, company-paid charge designation and no COD. This does not declare an obligation paid or enable a payment provider. |
| `bindOrderBillTo` / `acceptOrderPrice` | Explicit scoped payer instruction and immutable accepted UZS 110.0100 standard price. No recipient/COD/Float estimate inference. |
| `assignDriversBulk` / `updateDriverOrderStatus` | Authoritative expected-state assignment, then `assigned -> pickup_in_progress -> picked_up` by the assigned eligible driver; source-bound owned notifications persist. |
| Onward transition boundary | Driver `picked_up -> out_for_delivery` rejects with `Driver cannot move order`; operator bulk `picked_up -> at_warehouse` rejects with `manual transition policy is unavailable`. Captured business rows are unchanged. No direct status update, fake exception or invented warehouse transition bypass. |
| `submitProofForActor` | Truthful **pickup** proof by the assigned driver. Actual installed PNG decoder/re-encoder and stroke rasterizer; photo/signature stored through an explicitly mocked immutable storage boundary. Server receipt time is distinct from the labelled client capture time. No final delivery is claimed. |
| `issueOrderInvoiceForActor` | Issued UZS 110.0100 invoice, equal to the configured legal entity base currency, from accepted price and explicit payer at the configured eligible `picked_up` state. One held `invoice.issued` fact; no accounting posting/payment intent. |
| Original creation/acceptance/proof/issuance retries | Same order, accepted price, proof receipt and invoice returned after authorization. Captured database state unchanged; one order/creation receipt/price snapshot/invoice/label job, two proof attachments, two total mock storage writes. No repeated notification, tracking, audit or captured outbox facts. |

The supported connected workflow ends at confirmed pickup evidence and eligible invoice. Completing physical delivery needs the approved actor/state/assignment matrix for pickup-to-warehouse intake and onward last-mile transitions. Current contained manual transition paths must remain contained until that decision is made. Invoice issuance at pickup is this explicit synthetic configuration only; it is not a default or an assertion of real-company eligibility.

## Evidence executed and reused

Executed `node "$env:TEMP/cp-connected-journey-run.cjs"`, derived from the existing isolated configured-billing runner with only the target suite changed. It runs `node node_modules/jest/bin/jest.js --runInBand tests/security/connected-backend-journey-postgres.integration.test.ts --testTimeout=60000` after the current migration chain. **111 migrations applied; one distinct connected PostgreSQL case passed** (56.677 s suite; 8.928 s case). This is one connected scenario, not nine independent tests or new concurrency evidence.

Two earlier attempts failed on test prerequisite provisioning: missing required customer `type` (zero cases executed), then missing deliberate operator `shipment.bookCarrier` capability (real creation returned its existing authorization warning). Corrected inputs/grants; no application guard or assertion was weakened. The automatic carrier path now executes its real authorization and empty owned-leg lookup without any configured provider/routing rule. No provider call is enabled.

Final `node node_modules/typescript/bin/tsc --noEmit`: exit 0. No build, client generation or dependency change. Initial no-emit failure was the missing customer type above; the final check covers the corrected file.

Verified cleanup for all attempts: `cp-verification-e70b6cf532bb`, `cp-verification-0e27a63579be`, and final `cp-verification-d9028b9dbb84`. The existing runner checks exact name/run label and owned tmpfs, no bind/volume, before removal and verifies absence. New loopback-only PostgreSQL instances used synthetic credentials, no inherited database endpoints, bounded memory/CPU/PIDs, SQL/pool/process deadlines and marker-verified database ownership. No existing resource was modified.

Reused unchanged evidence in Configured_Pricing_Invoice_Workflow.md (30 distinct configured-billing PostgreSQL cases, 13 calculation and nine mocked HTTP cases), Order_Creation_Master_References.md, Proof_Submission_Idempotency.md, Atomic_Dispatch_Notifications.md and existing bulk-dispatch/revocation/real Socket.IO reports. Their exercised application/schema/dependency/configuration source is unchanged. No broad suite, audit or concurrency campaign rerun.

## External and compatibility boundaries

S3 `send` is a synthetic in-memory immutable-object mock; signed URL creation and Redis execution fail explicitly if invoked. HTTP/HTTPS/fetch are forbidden and asserted unused. PNG and stroke processing are real; S3 persistence, native capture, distributed reconciliation and provider transport are unverified here. The real label acceptance writes a pending durable job; generation/worker execution is not claimed. This case persists notifications but does not run Socket.IO; unchanged prior real transport evidence is reused.

No API or client contract changed in this batch. The journey uses existing selected user/tenant/TM/CM context; creation UUID `operationId`; nested `addresses.senderAddressId`/`receiverAddressId` plus `customerEntityId`; explicit bill-to instruction; price acceptance UUID/reason; complete authoritative assignment `expectedStates`; immutable proof `submissionId`/PNG/strokes/content/context and separately labelled `clientCapturedAt`; issuance UUID/`priceApprovalId`/reason; exact decimal-string responses. Clients remain deferred, and this test does not verify their configuration/payer/price/issuance UX. Ambiguous proof storage remains reconciliation-required under the existing contract.

Remaining release gates are unchanged: approved real-company settings/eligibility/provisioning and payer evidence, manual dispatch transition policy, accounting/FX/corrections/provider recovery, real S3/device/Redis/native transport and infrastructure verification, history/null certification and source-to-dist rollout. No full isolation, exactly-once delivery or production readiness claim.
