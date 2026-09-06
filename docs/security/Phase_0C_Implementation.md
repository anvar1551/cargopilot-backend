# Phase 0C containment

Base: `be0a7ce8c7fed719651bfc5531b9bb48e77c6680`. This milestone does not establish production readiness. The existing findings and security architecture sections 14.1–14.4 guide the affected call-chain review.

## Short implementation plan

1. Replace configurable integration fetches with bounded HTTPS requests to server-allowlisted origins. Resolve and reject special-use addresses, pin the socket destination, retain original-host TLS verification, and reject redirects. Cover both adapter and webhook-sink dispatch consumers.
2. Keep original headers/raw bodies available only to verification. Persist a minimal normalized header allowlist and digest/verification metadata in existing JSON fields; retain callback processing semantics and leave historical records/recovery untouched.
3. Reject supplied SVG; decode/re-encode supported PNG photos and generate raster signatures from bounded numeric paths in limited worker threads. Keep assignment/storage authorization, use server receipt time and separately label optional client capture time. Preserve PNG proof submission; report the missing JPEG/WebP decoder dependency decision.
4. Apply a formula-safe CSV cell helper to order exports, preserving quoting and typed numeric values. Add focused mocked boundary tests and real local PNG codec tests, run affected regressions/no-emit checking, and export the focused diff/full new files outside the repository.

## Decisions established before implementation

- Installed `pngjs` 5.0.0 supports PNG decoding/encoding and is already present transitively. `sharp`, `jimp` and `jpeg-js` are absent. No dependency is installed or changed. The approved subset will be non-interlaced 8-bit PNG: the installed decoder bounds non-interlaced inflation by dimensions, while its interlaced path lacks that bound. JPEG/WebP support requires a separately approved maintained raster decoder (for example sharp), and direct dependency ownership/version review remains a release gate. Merely checking MIME/magic bytes will not be represented as decoding.
- Integration request consumers are carrier/SMS adapters and webhook-sink outbox dispatch. A per-provider server environment origin allowlist is required, independent of configurable URLs/payload headers. HTTP/local fake-carrier endpoints become incompatible; no private-network exception or live smoke test is introduced.
- Tracking has no client-capture timestamp column. New proof responses and S3 object metadata can carry a separately labelled client timestamp without a migration; tracking timestamps remain server receipt times. Later list responses cannot reconstruct that optional value without separately reading metadata or adding a schema field.
- The only business CSV export found in the affected source is the order export. The import template and import parsing are not changed.

## Current enforced behavior

### Configurable outbound integrations

`integration-destination.ts` and `integration-http-client.ts` protect the carrier/SMS adapters and webhook-sink dispatcher. Only HTTPS on port 443 is accepted. URL credentials, fragments, invalid hostnames, trailing-dot hosts and private/special-use addresses are rejected. IPv4 normalization occurs through URL parsing; IPv6 permits only the global 2000::/3 subset with explicit special-use exclusions. Mapped IPv4, NAT64, local, multicast and other non-global IPv6 are denied, including mapped public IPv4. All returned A/AAAA answers must be public; mixed public/private answers fail closed.

The operator must set `INTEGRATION_HTTP_ALLOWED_ORIGINS_<PROVIDER_CODE>` to comma-separated exact HTTPS origins, with the code uppercased and hyphens replaced by underscores. For example, the inert documentation value `INTEGRATION_HTTP_ALLOWED_ORIGINS_EXAMPLE=https://partner.example.com` illustrates the format, not an approved production destination. Missing policy denies dispatch. Case/hyphen/underscore normalization can share a policy key between similarly named provider codes; configuration owners must account for that. A configurable URL or selected provider secret cannot expand this server policy.

Each request resolves with a dedicated cancellable resolver, validates every answer, and connects directly to one validated IP. The original hostname remains the HTTP Host, TLS SNI (for DNS names), and certificate identity being verified. Certificate verification stays enabled. There is no unrestricted second lookup, proxy agent, redirect following or address fallback. Webhook-sink policy uses the resolved provider identity. Dispatch diagnostics retain origin only, removing path/query and URL credentials.

| Resource | Source-enforced limit |
| --- | --- |
| Admission | 32 active requests per process; no waiting queue in this client |
| DNS | Resolver timeout 1 second, one try; cancellation at 1.5 seconds or overall abort; at most 16 answers accepted |
| TLS connection | At most 3 seconds, also covered by overall deadline |
| Overall request/body | Default 5 seconds; caller value clamped to 100 ms–15 seconds |
| Request | JSON body at most 1 MiB; bounded header count and aggregate 16 KiB; transport/proxy headers cannot be overridden |
| Response | Default 1 MiB, configurable up to 4 MiB; declared and streamed sizes checked; response header parser capped at 16 KiB |
| Teardown | Response/request/socket destroyed on completion or rejection; admission retained until underlying closure; no client automatic retry |

Redirects, upgrades and compressed responses are rejected. DNS/network failures and timeouts remain retryable through existing dispatch policy; destination/resource policy errors do not create a bypass. Existing outbox scheduling and provider operations are not redesigned. An HTTP timeout alone is not cancellation evidence: the implementation invokes DNS cancellation/socket destruction and retains admission through closure. Native cancellation, TCP/TLS behavior and OS closure timing remain unverified by these mocks. The static conservative address policy requires maintenance; per-tenant/distributed fairness and deployment egress controls remain outstanding.

### Webhook metadata

Original headers and raw bodies still reach signature verification unchanged. Integration raw-event writes apply the projection both at the gateway and repository. Newly written user-agent metadata is null. The existing raw payload digest, event identifiers and signature result remain intact. The explicit stored header allowlist is normalized `content-type`, `x-request-id`, `x-correlation-id` and `x-event-id`. Only selected media types are retained; bounded scalar UUID identifiers remain readable and other opaque identifiers are SHA-256 hashed. Array/control-containing values are dropped. Authorization, cookies, API keys, signature headers and arbitrary headers are excluded. No sensitive logging is added.

Payment webhook `headersJson` now contains `{ headers, payloadSha256, digestSource, signatureVerified }` in both upsert branches. The digest uses raw bytes when available; a parsed-JSON fallback is explicitly labelled and does not substitute for signature verification. Existing provider/event columns remain unchanged. Integration invalid-signature rejection, duplicate handling and persistence-error propagation are preserved; an unpersisted event is not newly acknowledged as successful. Existing payment processing statuses, support-ticket behavior for invalid signatures, settlement/refund behavior and callback recovery are unchanged and are not certified correct by this phase. There is no blanket claim of zero legacy business effects for invalid payment callbacks.

Historical database records are not rewritten. Raw payloads and existing IP metadata still require appropriate retention/access controls. This change contains new broad header retention on the affected paths; it does not resolve historical retention or all callback security/recovery findings.

### Proof uploads and timestamps

Submission requires current active company authority with `shipment.update`, matching order ownership and the assigned driver. This strengthens current CompanyMembership compatibility enforcement; it does not implement the target Tenant model. New keys include company/order/proof identifiers. Listing preserves its existing authorization and skips keys with foreign order/company ownership before presigning; legacy order-prefixed keys remain readable.

Photos must actually decode as non-interlaced 8-bit PNG with valid CRCs. PNG signature/chunk checks are resource preflight only: the installed codec decodes pixels and re-encodes a new RGBA PNG before any storage or attachment/tracking writes. Input metadata is not copied. SVG/SVGZ, JPEG, WebP, animated PNG, unsupported bit depths/interlacing, malformed/truncated images and trailing content are rejected. Client `signatureSvg` is rejected. Bounded numeric signature paths are drawn into a new PNG without SVG interpretation. Both outputs have server-controlled PNG filenames/types and attachment content disposition.

| Resource | Source-enforced limit |
| --- | --- |
| Multipart | One file; six fields; seven parts; 32,768 bytes per field; photo cap is the smaller of configured limit and 6 MiB |
| Photo | At most 6 MiB, 4096 pixels per dimension, 4,000,000 pixels, 4096 chunks |
| Signature | At most 64 strokes and 2048 total points; bounded coordinate text and x ≤ 1024, y ≤ 512 |
| Processing | Two worker threads per process, no queue, 3-second deadline; termination awaited before releasing admission |
| Worker memory | V8 old/young heap limits 64/16 MiB and 2 MiB stack; each encoded output capped at 16 MiB |

Worker heap limits are not total RSS or native Buffer limits. Input/dimension limits bound codec buffers; OS/container memory controls and load behavior remain unverified. Multipart buffers are allocated before object-level service authorization, under the request size cap; aggregate inbound/per-tenant resource controls remain later work.

New authoritative tracking and response `savedAt` values use server receipt time captured before multipart buffering. Optional `clientCapturedAt` (or legacy `savedAt` input) remains explicitly untrusted, separate metadata; invalid or conflicting timestamps reject before codec/storage. It is stored in new S3 metadata and returned at submission, but not subsequently reconstructed in proof lists because there is no schema column. Existing S3/database best-effort cleanup is preserved, not made atomic: partial uploads can leave orphans, and proof idempotency/concurrent authorization revocation remain open.

### CSV export

The shared `csvEscape` helper is wired into the existing authorized order export. Text beginning with `=`, `+`, `-` or `@`, including leading whitespace/Unicode control/format variants, is prefixed with an apostrophe. Leading tab/CR/LF variants are also neutralized. All cells retain CSV quoting and doubled embedded quotes. Finite typed numbers, bigint and Prisma Decimal remain numeric text without the added apostrophe, including negative amounts. Numeric-looking strings remain untrusted text. Import semantics and the import template are unchanged.

## Compatibility and rollout review

- Carrier/SMS/webhook-sink endpoints need reviewed server origin policy before use. HTTP, private/local fake-carrier URLs, non-443 destinations, redirects and compressed responses no longer work. No deployed policy, DNS, proxy or firewall configuration is inferred from source.
- Proof clients must send supported PNG photos and bounded numeric paths, omit `signatureSvg`, and treat `savedAt` as server receipt time. JPEG/WebP and existing SVG submission clients are incompatible until adapted or a separately approved raster dependency enables their safe processing. Signatures now use PNG, and new storage keys include company ownership. Frontend proof types/display consumers were inspected read-only; no frontend changes or runtime verification occurred. Driver-client compatibility is unverified.
- New payment webhook metadata has a nested JSON shape. Internal tooling expecting broad/flat headers or user-agent values must adapt; non-UUID correlation identifiers are now hashed. No historical backfill is performed, so old/new metadata shapes coexist.
- Spreadsheet exports may visibly show apostrophes in text-only consumers. Formula-like strings, including text phone numbers starting with `+`, are intentionally neutralized; typed financial values and CSV quoting remain intact.
- There is no schema/dependency migration. The installed PNG codec is transitive, so explicit production dependency ownership/version and advisory review are required. The narrow outstanding dependency decision is whether to approve a maintained raster decoder such as sharp, with direct version ownership, to restore bounded JPEG/WebP decoding. No package was installed and supported PNG uploads remain functional.
- Rollback requires security review because reverting these guards reopens the affected boundaries. Preserved dist is not a reviewed deployment artifact. No deployment or rollback was executed.

## Validation results

Installed tooling only; commands ran from the repository. No database, Redis, AWS, provider, DNS or HTTP connection was opened. Network, storage, repositories and provider operations were mocked. Carrier adapter tests were converted from loopback HTTP servers to client mocks. Actual local worker-thread PNG decode/re-encode and malformed-CRC rejection were exercised; TLS hostname checking used an offline certificate fixture. No new elaborate harness was built.

Initial focused run:

```powershell
.\node_modules\.bin\jest.cmd --runInBand --detectOpenHandles --runTestsByPath tests/security/integration-destination.test.ts tests/security/webhook-metadata-boundary.test.ts tests/security/proof-upload-boundary.test.ts tests/security/csv-export-boundary.test.ts tests/integrations/provider-adapters.test.ts tests/integrations/outbox-dispatcher.test.ts tests/integrations/hmac-webhook.verifier.test.ts
```

Exit 1: four suites passed and three failed; 125 tests passed and two failed (127 executed), 39.052 seconds. Fixes corrected a Worker namespace spy, an Error realm assertion and a deliberately adversarial fixture's TypeScript type. The latter initially prevented the outbox suite from running. Review also strengthened socket-closure admission and protocol-upgrade teardown, adding two targeted regressions.

Affected rerun:

```powershell
.\node_modules\.bin\jest.cmd --runInBand --detectOpenHandles --runTestsByPath tests/security/integration-destination.test.ts tests/security/proof-upload-boundary.test.ts tests/integrations/outbox-dispatcher.test.ts
```

Exit 0: **3/3 suites, 89/89 tests passed**, 24.981 seconds; no snapshots or open-handle warnings. The other four suites and their tested source were unchanged after their successful run: **43/43 tests passed**. Together, final-source evidence is **132 passing tests across seven suites**, assembled from those recorded runs, not a claim of a second complete seven-suite run. No Phase 0A/0B suites were repeated. Existing HMAC verification was included because this phase changes adjacent webhook metadata handling.

```powershell
.\node_modules\.bin\tsc.cmd --noEmit --pretty false
```

Initial source-only check exited 0. The first check with added tests exited 1 on the outbox fixture TS2353; after correcting that fixture, the final no-emit check **exited 0 with no diagnostics**. No source/test edits followed the successful affected rerun and final type check. Only this report/export was finalized afterward.

Coverage includes public/foreign/private/mapped destinations, allowlist mismatch, DNS answer mixing and cancellation, pinned IP/original-host TLS options, redirect/upgrade and response limits, admission/deadlines/teardown; raw-body tampering, minimal metadata, duplicates and persistence failure; authorized/foreign/revoked/unassigned proof cases, real image processing and resource limits, timestamp authority and ownership-preserving links; dangerous CSV text, typed numbers, quoting and export authorization. Rejection assertions establish no affected business writes or external calls in mocked paths. Mocks do not prove PostgreSQL isolation/concurrency, provider delivery, native network teardown or infrastructure behavior.

Whitespace review uses `git -c core.safecrlf=false diff --check -- . ':!dist'` plus checks of newly added files. Focused changes and new files are reviewed for credential patterns without printing private files. The export includes the tracked implementation diff against the base and complete new source/tests/report with a SHA-256 file manifest. Dependencies, private files, dist and unrelated work are excluded; nothing is staged or committed.

## Remaining release gates

This is **partial containment, not production readiness**. The narrowly addressed new-header retention and outbound/proof/export boundaries do not waive other findings in the security architecture or the Phase 0A/0B reports:

1. Redis limiter lifecycle/backpressure and real Redis validation remain outstanding, including pending/retried work, teardown, Lua/ACL/TTL behavior and outage recovery. No Redis harness execution occurred.
2. Existing PATCH access/role grants, administrative service grant ceilings and typed scope ownership still permit unresolved escalation risks. Enrollment containment is not a complete privilege-escalation fix.
3. Structural tenant ownership, tenant-matching database constraints, warehouse/customer/address scope and full cross-tenant negative evidence remain incomplete. Customer/address master references stay rejected; Phase 0B creation remains company-scope-only. Tenant/TenantMembership are planned target architecture, not established enforcement.
4. Invoice-required checkout and its frontend incompatibilities remain. Durable order/import idempotency is missing. Approved immutable payable lifecycle, exact upstream pricing, legal-entity compound constraints, partial import/label effects and historical ownership mapping remain unresolved.
5. PostgreSQL applied constraints, locking, races, deadlines, rollback and callback concurrency are unverified. Durable provider recovery/reconciliation, merchant/environment/currency assurances and unknown initiation outcomes remain gates; automatic safe redispatch is not established.
6. Existing payment callback/refund/settlement reconciliation, integration raw/canonical/queue atomicity, duplicate recovery, retry/redelivery and callback resource policies remain unresolved. Historical sensitive headers/raw payloads and SVG proof objects are not remediated; legacy proof links remain compatible.
7. Native DNS/TLS/transport validation, allowlist deployment, egress controls, per-tenant resource fairness, raster dependency ownership/advisories and OS memory/load evidence are outstanding. Safe JPEG/WebP processing needs the explicit narrow dependency decision above.
8. Proof S3/database atomicity, orphan recovery, idempotency, concurrent permission/assignment changes and durable capture-time storage remain open.
9. Refresh/session/realtime consistency, bootstrap privilege seeding/auditing/atomicity, deployed proxy/network/Redis controls, liveness/readiness contracts and frontend/driver runtime compatibility retain their prior blockers. Bootstrap, migrations, services and live infrastructure were not executed or accessed.

All other previously recorded blockers remain open. This phase changes no frontend, dependency, database record or generated dist output, and performs no staging, commit, push or deployment.

## Focused review correction: outbound admission

Temporary outbound admission exhaustion now raises `ECAPACITY`, classified as retryable. Explicit `EDESTINATION`, `ELIMIT` and `EREDIRECT` remain permanent even when a diagnostic contains timeout-like text. Capacity rejection occurs before DNS or network work. The dispatcher preserves the real classifier result for the existing attempt-capped, exponential backoff/jitter outbox policy; no immediate retries or new replay after uncertain provider outcomes were added. Existing provider recovery gaps remain.

Validation: `jest.cmd --runInBand --detectOpenHandles --runTestsByPath tests/security/integration-destination.test.ts tests/integrations/outbox-dispatcher.test.ts` (installed `node_modules/.bin` tool) exited 0: **2 suites, 72 tests passed**, 35.09 seconds, zero snapshots. Tests cover admission before DNS/network, dispatcher classification without immediate replay, and permanent destination/request-size/response-size rejection. `node_modules/.bin/tsc.cmd --noEmit --pretty false` exited 0 with no diagnostics. Unchanged evidence above is reused; no services were contacted and the full export was not regenerated.

No new blocker. PNG-only compatibility, transitive codec ownership and native transport validation remain explicitly unresolved, alongside all prior release gates. Dist and unrelated work remain preserved; nothing was staged or committed.
