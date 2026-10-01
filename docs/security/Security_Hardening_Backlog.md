# CargoPilot security hardening backlog

## Current state / resume

2026-10-01. Support checkpoint 3d7f4915382c391d3eb52b371a388dcfe8effa3b verified; administrative delegation containment checkpoint is 3cf4626eb1ac02bd75c70f751977293653076a82, plus preserved unrelated tracked/untracked dist. Frontend HEAD 5bfae6ed9e4b9f1ec48883788bc5dee220f860c9; driver HEAD b7040eadf47850fa6f8392a45c6b7370c03125da; both clean. Neither client root has AGENTS.md. Backend AGENTS.md and approved architecture govern this mission. One agent; no existing-service access, pushes, deployment or resets. Synthetic disposable resources require unique identity and ownership-verified cleanup.

Current task: bounded invoice read/signing and issuance authority inspection. Next action: inspect invoice read/signing authorization and its consumers as a bounded finance task. Runtime administrative delegation is not approved merely because an actor holds membership.invite or role.bindPermissions.

## Completed checkpoints / retained evidence

Commit references below are verified in local history. Earlier reports are evidence leads, not a renewed audit or claims about deployed enforcement.

| Slice | Backend commit | Current classification / evidence lead |
|---|---|---|
| Phase 0A enrollment, projections, auth limiting | 4416941 | Containment; Redis lifecycle/real Redis evidence still outstanding. Phase_0A_Implementation.md |
| Phase 0B financial/order authority | be0a7ce | Invoice-before-checkout, customer/address master-reference containment; order/import idempotency still absent. Phase_0B_Implementation.md |
| Phase 0C outbound/webhook/image/CSV boundaries | 187cd17 | Implemented bounded guards; PNG only, codec ownership/native transport unverified. Phase_0C_Implementation.md |
| Tenant additive foundation / populated relationship constraints | e81f4ae / bede6f2 | Partially migrated nullable ownership; fixtures and PostgreSQL constraints are not complete isolation. Tenant_Schema_Foundation.md |
| Tenant sessions / Socket.IO delivery | ddd2046 | Selected tuple enforced on covered paths; refresh-family races/distributed revocation open. Tenant_Bound_Sessions.md |
| Notifications / customer-address / pricing-import / orders | db5a5fe / 23a2aea / e6b964b / 626d4d0 | Covered entry points scoped; legacy/null ownership and adjacent paths remain. Corresponding containment reports |
| Order children / durable workers / sandbox ingress | 3ed8fbe / d1b51d1 / ab30db4 | Durable specific capabilities; real providers, recovery/reacceptance unsupported. Order-child/worker tests and reports |
| Cash custody / cash-finance worker | c648e43 / e6338dc | Covered custody atomic; approved accounting mappings required. Cash_Custody_Containment.md / Cash_Finance_Worker_Containment.md |
| Proof durable identity / warehouse | 25fe290 / f666e25 | Proof uncertain storage reconciliation open; warehouse assignment/provisioning contained. Warehouse_Tenant_Containment.md |
| Support | 3d7f491 | 21-file manifest, fresh selected context and transactional owned events. Support_Tenant_Containment.md |

Client membership/proof/cash checkpoints are present at the verified client HEADs; exact login selection and context-bound cash/proof intent behavior was previously tested. Browser/native device behavior is not verified. No changes to clients in the current support checkpoint.

Support evidence reused from the preceding task because its source/tests, dependencies, schema and relevant config are unchanged: Jest command in Support_Tenant_Containment.md passed 43 cases, three new support cases passed separately (46 distinct), three affected notification cases passed; disposable PostgreSQL applied 72 migrations and passed 18 distinct cases assembled across scoped runs (reruns not added); final affected order/merge rerun 2 passed. Offline Prisma validation and final tsc --noEmit passed. PostgreSQL used only new owned synthetic containers/tmpfs; cleanup recorded. Unit authentication/storage/transport mocks are distinct from actual PostgreSQL transactions. Warehouse evidence: 46 plus separately executed HTTP case, 47 distinct. No unchanged tests repeated for checkpointing.

## Ready work and blocked dependencies

| Priority / work | Status / source lead | Dependency and acceptance criteria |
|---|---|---|
| Role/scope escalation | Contained: HTTP and alternate service grant/profile/delete paths deny; catalogs/directory require fresh selected tuple and explicit company scope; permission catalog seeding no longer expands owner roles. Existing grants and manual bootstrap are not certified | Immediate containment of undefined grant paths including alternate service callers and role-definition escalation. Fresh selected reads, tenant/company directory isolation, no platform grants/self-approval. Tests prove no writes on denial. Business decision: delegator eligibility, explicit grantable permissions/roles and typed resource ceilings, independent approval and revocation/provisioning policy. No fabricated administrator. |
| Finance API/legal-entity/repository/worker paths | Previously recorded gap; cash worker covered, remainder not yet reconciled in this mission | Trace one operation and consumers; current tenant/entity, workflow and maker-checker checks; exact money and balanced immutable postings. PG atomic/concurrency evidence when changed. Missing accounting mappings remain contained. |
| Dispatch, integration, analytics, live-map/cache/job/export paths | Unreviewed remainder after covered slices, not asserted uniformly vulnerable | Pick one authoritative record/path; scope all synchronous/derived boundaries with no generic worker bypass; reject before effects and test queries/files/events. Preserve existing calculation/workflow contracts. |
| Refresh family / reuse / concurrency | Reported remaining session race, not atomic family design | Inspect consume/create transaction and clients; durable family/reuse design with PostgreSQL concurrency and rollback evidence; no silent context switching. |
| Distributed revocation / Redis lifecycle & backpressure | Partly implemented connection/delivery checks; Redis behavior unverified | Isolated real Redis, bounded underlying work and recovery; never treat HTTP timeout as command cancellation. Document remaining concurrent revocation timing. |
| Order/import idempotency / recovery | Durable order/import identity absent; import partial success documented | Define immutable server-normalized intent/context and unique durable receipt; PG concurrent retries, conflict/no-effects and explicit uncertain provider recovery. |
| Client payment / real browser-device verification | Compatibility/infrastructure evidence gaps | Inspect actual server contract and client consumer; fresh selected authorization and authoritative invoice money; unit evidence separately from device/browser/provider evidence. |
| Proof reconciliation / notification transport / support producers | Uncertain storage and delivery remain; generic support producers and global SSE contained | Owned incomplete receipts cannot be blindly replayed/deleted. Restore a specific producer only from durable accepted source with idempotency; authorize recipient at delivery. No real S3/provider calls. |
| Provisioning / nullable ownership / constraint certification | Transitional fields/NOT VALID constraints, no historical mapping performed | All existing data declared synthetic; no forensic assessor. Prepare deterministic new-test provisioning, explicit company selection and reviewed grants. Existing-database migration/reset/backfill still NOT authorized. PG certification/recovery before non-null cutover. |
| Legacy Float financial authority / policy.override / maker-checker | Recorded adjacent release gates; scope-specific protections implemented | Trace one authoritative finance operation; no inventing conversion/accounting/threshold rules. Generic overrides cannot bypass boundaries or actor separation. |
| Dependencies / CI / build provenance | Earlier advisory counts historical, not current audit findings | Reachability and compatible fix review per package, no blind upgrade. Inspect CI triggers offline; one broader regression at a major milestone; never regenerate preserved dist as validation. |
| Infrastructure / RLS | Infrastructure assumptions unverified; RLS optional deferred defense in depth | Separate authorization needed for deployed infrastructure. RLS assessment follows application/relational enforcement and cannot replace it. |

## Business decisions and operational limits

No approved delegation ceiling, emergency override, warehouse membership assignment policy, general provider recovery/reacceptance/cancellation contract or retention/legal-hold policy is invented. Support retention preserves the prior configurable 30-day default for synthetic operational tickets; it is not an approved production retention requirement. Accounting mappings and FX/conversion policy must come from approved financial rules. These blocks do not stop independent containment.

Mission checkpoint entries must record exact commit/worktree, exercised-source evidence, command/environment, limitations and exact next action. Stop only for completion, all useful work blocked, unsafe isolation or session/execution limits. Resume instruction: read this record, verify actual repositories without resetting, finish the current bounded slice, update evidence and checkpoint only its explicit reviewed files. No production readiness or complete tenant isolation claimed.

Administrative containment evidence: 28 new mocked/HTTP cases passed; 21 affected tenant-session cases passed; alternate warehouse creation case passed and 3 admin-assignment cases run separately. Final no-emit type checking passed. Details/initial failures/limitations are in Delegation_Containment.md. No migrations or transactional database changes, so no new PostgreSQL run or concurrency claim. No approved delegation ceiling or durable authorization-version model exists; accepted privileged audit/version updates are prerequisites to restoring grants. Next bounded candidate: invoice list/file-signing paths currently use a tenant-only order helper and can reach another selected company; issuance also creates tenant-null rows and uses Float-derived pricing, requiring separate monetary/issuance containment review before any restoration. These are source leads, not live database findings.

Checkpoint 3cf4626 contains the seven-file delegation slice. An EOF-only whitespace correction and truthful check-result update follow; tests reused because exercised behavior is unchanged. Future git checks/commit use throwing child_process execution so failed checks stop commits. Clients remain at the verified clean HEADs; backend unrelated dist remains preserved.
