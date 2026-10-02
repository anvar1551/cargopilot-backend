# Operational pricing source boundaries

Current enforced behavior: the seed helper uses established fresh parent permission
`shipment.create`, requires the selected owning company, locks the order FOR UPDATE,
reloads active tenant/company ownership, and proves template/company/tenant/child
consistency before writes. Existing leg references are checked; foreign, partial,
conflicting or more than100 legs/templates reject before component/event writes.
No requested foreign template silently substitutes a system template. Absent
template retains the existing system-leg behavior. Statement/lock/transaction limits
are3s/1s/5s with2s transaction admission. Parent locking serializes covered seeds;
this is not durable order/import identity or a global component uniqueness claim.

The two located producers remain normal order creation and import, both using
prepared server pricing. Their best-effort seed failures and partial import success
are unchanged: order creation can commit before a seed failure. No atomicity across
those separate transactions or financial acceptance is claimed. Existing estimate
allocation/calculation is unchanged and still uses Number intermediates; it is not
an approved exact-money/FX basis for invoice issuance or finance execution. Those
workflows remain contained pending approved exact pricing, FX and acceptance policy.

Manual component creation is now409 after fresh parent `shipment.update`
authorization, before money/source/FX input, child lookup, business write or event.
The unsupported workflow needs immutable server-normalized pricing intent, exact
money/FX policy, permitted adjustment transitions, independent acceptance and
eligible separate checker rules; none are invented. The unused context-free payable
calculator is replaced by fresh parent `shipment.view` then the same409 containment.
No current source caller was found. Calculated estimates never confer paid state or
financial obligation authority. This is disabled functionality, not restoration.

Component reads require fresh existing parent scope, repeat tenant/order and child
order ownership, use explicit projections and return exact decimal strings in the
existing items envelope. Read-only RepeatableRead snapshot and native deadlines;
more than100 components rejects409 instead of a partial financial read. No raw
metadata, credentials or private nested objects are selected.

New migration `20261003030000_pricing_component_order_leg` reuses the existing
`OrderLeg_id_order_key` and adds one compound NOT VALID FK. Populated child references
must belong to the component order. Null leg remains a valid order-level component;
the order's nullable tenant transition is unchanged and must still be denied by
application context checks. Existing simple FK intentionally retained. New/changed
references checked, historical rows not certified; no backfill or posted-data edits.
Apply expansion before application cutover. Rollback must preserve equivalent
protection or keep affected paths disabled. OrderLeg's own template/company graph
still lacks durable compound ownership; seed/selector checks do not certify that
separate relationship.

Compatibility: POST order pricing-components now409; GET remains `{items}` with
decimal strings and explicit resource-capacity error. No frontend/driver edits or
browser/device verification. Server-created order/import estimates still work for
owned valid templates, without lifting customer/address, invoice checkout or
financial-policy containment.

Validation:80 affected pricing-source, creation/import and invoice-read mocked cases
passed plus1new reseed predicate unit case; offline Prisma validation/ignored generation and no-emit passed. At91 full
migrations, owned7c3deccaf3ee passed2native cases (actual concurrent seed/fresh scoped
component reads and compound insert/update/parent-reparent/rollback) and failed the
injected-post-outbox case before injection because an existing synthetic sequence
did not map to its test template. Fixture corrected without relaxing assertions;
ownedf8f4a3a45925 focused rollback rerun passed. Final review repeats orderId at
the actual component update; its new unit test passed and owned2e0a107c7253 reran
only the affected concurrent seed case, passed. Three distinct native scenarios,
not four/five new cases. Both correction resources removed after ownership/storage
checks and filtered absence. Final no-emit passed. Cleanup ownership/label/tmpfs/no-bind/no-volume and
absence verified for the failed resource. No external provider/storage evidence,
exactly-once event claim or historical certification.

Commands: installed Node node_modules/jest/bin/jest.js --runInBand --runTestsByPath
tests/security/order-pricing-source.test.ts tests/security/order-creation-authority.test.ts
tests/security/invoice-read-containment.test.ts; node_modules/typescript/bin/tsc --noEmit;
%TEMP%/cp-cash-schema-check.cjs (no-dotenv config); existing guarded disposable
cp-pricing-source-run.cjs then cp-pricing-rollback-run.cjs and cp-pricing-reseed-run.cjs, native file
integration-metadata-postgres.integration.test.ts and focused pricing-source pattern.
Schema/source/catalog review verifies selected relationships, not complete semantic
schema-to-migration equivalence.
