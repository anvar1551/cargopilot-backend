# Phase 0A implementation and review report

## Outcome and authoritative scope

The narrowly bounded Phase 0A containment work is implemented and validated at the
source/unit levels below. This is not release approval or a claim of complete
administrative privilege-escalation prevention, tenant isolation or production
Redis assurance. Bootstrap redesign is explicitly not a completion gate for this
phase; its existing gaps remain documented and its entry points were not run.

Implementation and review base: `041ec6c7a2875cd6539a03b75c571031345d78a5`.
Active instruction sources: user-supplied AGENTS.md instructions and root AGENTS.md;
no ancestor/nested AGENTS.md was found. The full root instructions and security
architecture contract were read. The host fixes collaboration mode to Default;
a literal switch to Plan mode was unavailable. Written planning preceded edits.

Work continued in place. At the original start, env.ts, auth.service.ts, identity
routes and warehouseRepo.ts were dirty and abuseRateLimit.ts was untracked. Those
non-generated files were authoritative and completed without discarding prior
work. Existing tracked/untracked dist output was fingerprinted and preserved.

The continuation authorizes universal temporary denial of the administrative
creation HTTP endpoint, keeps login available, and explicitly permits sanitized
security audit events, metrics and bounded logging. The invariant is **no business
mutations or external business effects for rejected requests**, not a prohibition
on security telemetry. This implementation adds no rejection audit persistence or
sensitive logging. Tests observing no DB calls describe this implementation, not
an architectural ban on future sanitized security events.

## Plan and refinements

1. Inspect all enrollment/token issuance, warehouse user response paths, existing
   limiter work and available frontend/driver consumers.
2. Disable anonymous registration before parsing or enrollment work; replace
   warehouse model serialization with explicit query and response projections.
3. Complete shared authentication limiting with production fail-closed behavior,
   keyed identifiers, bounded HTTP waits, explicit bounded local fallback and trusted IPs.
   HTTP deadlines do not establish cancellation or bounded underlying Redis work.
4. After the user's continuation authorization, contain POST /api/auth and its
   trailing-slash alias for all callers, including membership.invite. Preserve
   existing login and sessions. Do not implement invitations or grant ceilings.
5. Review health/callback policies and source probe/recovery behavior. Remove only
   the new health/callback hook, its unused sample settings and its synthetic tests
   because a shared quota/retry contract was not established. Retain auth limiting,
   existing provider verification and body-size limits.
6. Document remaining PATCH/role/bootstrap/health/callback gaps, run focused tests
   and no-emit checks, verify dist/index preservation, then provide the complete
   public diff, full new-file contents and an unexecuted isolated Redis procedure.

All implementation milestones are complete within the latest authorized scope.
The plan changed at milestone 4 when containment was authorized, and milestone 5
removed the earlier broad public hook. No tenant/schema/finance/payment-authority
migration, database access, frontend changes or dependency changes were added.

## Current enforced behavior: enrollment and authentication

Source inventory found no alternate anonymous signup, invitation acceptance,
recovery/reset or identity creator. src/index.ts mounts identity routes at
/api/auth. The only remaining createUserByCompanyAdmin source occurrence is its
service definition; the HTTP transport no longer imports/calls it. The function
itself remains unsafe for future direct reuse and is not certified safe.

| Entry | Final behavior |
| --- | --- |
| POST /api/auth/register | Constant 403 `{ "error": "Registration is unavailable" }`, Cache-Control: no-store, before parsing or storage. Public registration/default-company service removed. |
| POST /api/auth and /api/auth/ | Constant 403 `{ "error": "User creation is unavailable" }`, no-store, for anonymous and authenticated callers, including membership.invite/system administrators. Denial is in onRequest before parsing, membership lookup or business services. Former anonymous 401 and authorized 201 are intentionally replaced. |
| POST /api/auth/login | IP limit before parsing, normalized-email limit before password work. Unknown user, wrong password and no active membership use the same 401 response. Synthetic bcrypt comparison reduces the obvious missing-user timing difference; no constant-time end-to-end claim. Successful token/refreshToken/user envelope remains unchanged. |
| POST /api/auth/refresh | IP plus keyed-token limits, generic invalid-session responses. Existing rotation semantics retained; concurrency/reuse gaps remain. |
| POST /api/auth/logout | IP limit, sanitized validation/internal errors. |
| POST /api/auth/change-password | IP limit, existing authentication, then authenticated-user limit before password work. Sanitized errors. |
| GET /api/auth/me | Existing authenticated identity response retained; regression proves an inviter's session still works before and after rejected creation. |

The denial performs no user, membership, role, scope, customer, session, outbox or
external business operation. Valid access tokens do not bypass it. Rejection does
not revoke a caller's session. No database/API schema migration is required.

### Frontend create-user contract

Read-only inspection of sibling cargopilot-frontend/lib/users.ts shows createUser
POSTs to /api/auth with name/email/password/roleCodes and optional branch,
warehouse, customer, driver type and scopes. The backend previously returned
201 `{ user }`; it now returns the constant 403 above. The create-user UI must
therefore be treated as temporarily unavailable.

components/manager/users/CreateUserDialog.tsx invokes that function through
useMutation. Its onError reads response.data.error into a toast; only onSuccess
shows 'User created', invalidates user/role queries, clears fields and closes the
dialog. Source therefore indicates the rejection should show the server message
without running success behavior. No frontend file was changed and runtime UI
behavior was not tested. Re-enabling this contract requires a later approved
actor-aware ownership/grant/audit design, not a flag that restores the unsafe path.

Frontend lib/api.ts and driver lib/api.ts plus their login screens consume the
preserved successful login/refresh envelope. Runtime compatibility is unverified.
Failed refresh (including 429/503) may cause their original 401 flow to sign out;
no Retry-After-aware client UX is claimed.

## Current enforced behavior: warehouse projections

Warehouse list/create/update explicitly project id, name, type, location, region,
latitude, longitude and createdAt. Detail adds users with id/name/driverType only
and orders with id/orderNumber/status/serviceType/createdAt/updatedAt only.
Full user models, refresh sessions, authentication metadata and unrelated order
contact/payment scalar fields are excluded from detail responses. DTO mapping
protects the transport even if a future repository result includes extra fields.
Warehouse exceptions return fixed messages and are no longer logged as raw objects.

The warehouse transport is the repository's only consumer. Related driver,
manager, order read/write, tracking, live-map and identity snapshot queries were
inspected and already use explicit user selects. CustomerEntity users:true matches
are counts inside _count. Existing dispatch/contact emails elsewhere were not
removed. Successful auth token envelopes are intentional; persisted hashes and
session records are not exposed by these changes. This is not a global privacy proof.

The inspected frontend lib/warehouses.ts uses scalar list/create/update fields;
those remain unchanged. Detail is intentionally narrower. Warehouse tenant
ownership/scoping and pagination remain unresolved and are not proven by leakage
tests. CompanyMembership remains partially migrated compatibility behavior;
Tenant/TenantMembership remain planned target architecture.

## Authentication limiter configuration and evidence

Installed ioredis executes a fixed Lua script combining INCR, initial PEXPIRE,
PTTL and TTL repair. A one-second deadline includes acquiring the shared client
and executing EVAL. Missing, stalled, invalid or failed shared results deny auth
work. Redis stores counters only and never becomes identity/authorization authority.
The design follows [Redis Lua atomicity](https://redis.io/docs/latest/develop/programmability/eval-intro/);
actual Lua execution remains unverified until isolated integration testing.

The HTTP deadline is not a Redis lifecycle/backpressure guarantee. Source review
of src/config/redis.ts and installed ioredis 5.10.1 establishes that
withRedisTimeout uses Promise.race without cancelling underlying work. The client
retryStrategy always returns a delay; maxRetriesPerRequest=1 does not bound the
reconnect loop. autoResendUnfulfilledCommands defaults to true, and a command
timeout does not cancel an already-sent command or necessarily remove its queue
entry. getRedisClient awaits connect before its later readiness wait, and recycling
awaits QUIT. Aggregate pending work, reconnect lifetime, admission/backpressure and
teardown during outages remain unresolved release gates. No production lifecycle
fix was added in the separate harness preparation; its finite safety limits apply
only to the proposed disposable test processes.

Keys contain prefix, normalized environment, fixed purpose and HMAC-SHA-256 over
environment/purpose/identity. Raw email, token and IP identifiers are not stored
in keys. Account activity counters are not exposed in response headers. Exceeded
limits return 429 plus Retry-After; unavailable backend returns 503. Both use
`{ "error": "Request cannot be processed" }` and no-store. Auth successes are
also no-store. Login/refresh/logout/password bodies are capped at 16 KiB.

| Setting | Default / requirement |
| --- | --- |
| NODE_ENV | Explicit development or test required for local fallback. Missing/unknown/staging use strict shared requirements. |
| RATE_LIMIT_KEY_SECRET | At least 32 non-padding characters outside development/test; identical stable secret on all API replicas. No real secret read/generated/installed. |
| REDIS_RATE_LIMIT_PREFIX | Defaults to `${REDIS_PREFIX}:rate-limit`; examples use cargopilot:ratelimit. Identical across replicas. |
| RATE_LIMIT_LOCAL_FALLBACK_ENABLED | false. true forbidden outside explicit development/test. |
| RATE_LIMIT_LOCAL_MAX_KEYS | 10000 per limiter; expires old entries, never evicts active counters. Full local store denies new keys with 503. |
| AUTH_RATE_LIMIT_WINDOW_MS | 900000 (15 minutes) |
| AUTH_LOGIN_RATE_LIMIT_MAX | 20 per IP and normalized email |
| AUTH_REFRESH_RATE_LIMIT_MAX | 60 per IP and refresh token |
| AUTH_LOGOUT_RATE_LIMIT_MAX | 60 per IP |
| AUTH_PASSWORD_RATE_LIMIT_MAX | 10 per IP and authenticated identity |
| AUTH_RATE_LIMIT_MAX | Legacy fallback for unset route-specific auth maxima remains supported. |
| TRUST_PROXY | false default; explicit IP/CIDR list, named ranges or positive fixed hop count. true/yes/on, /0 and invalid input reject startup. |

HTTP IP identity uses request.ip under [Fastify trusted-proxy semantics](https://fastify.dev/docs/latest/Reference/Server/#trustproxy),
never manual X-Forwarded-For/X-Real-IP extraction. A fixed hop count needs a verified
network path with shorter bypass paths blocked. Source configuration cannot prove
that topology. Fixed-window bursts, shared-NAT throttling, principal lockout abuse,
Redis counter loss on restart/eviction and operational tuning remain risks.

Removed sample PUBLIC_RATE_LIMIT_WINDOW_MS, PUBLIC_CALLBACK_RATE_LIMIT_MAX and
PUBLIC_HEALTH_RATE_LIMIT_MAX settings correspond only to the withdrawn hook.
Old RATE_LIMIT_REDIS_STORE_ENABLED was unused and removed from samples. Existing
generic/analytics/export/live-map settings do not prove unrelated route limiting.
Socket.IO uses a separate Engine.IO transport; it creates no user/session tokens
and is not covered by these HTTP hooks. Connection/event limits and existing
realtime membership-binding weaknesses remain unresolved. SSE keeps existing auth.

## Health policy review: liveness is not readiness

The newly added publicAbuseLimits.ts hook and its two index.ts lines were removed.
src/index.ts is now identical to HEAD. Auth limiter Redis failure therefore cannot
reject health requests through that removed hook. No replacement fail-open callback
hook or fake success response was added.

**Current enforced behavior, source evidence:** /api/integrations/health returns
static `{ module: 'integrations-core', status: 'ok', gateway: 'webhook' }`. Once the
app is running, this is a module liveness signal without request-time DB/Redis work;
it must not depend on limiter Redis. It is not a readiness or all-worker-health proof.

/api/health runs PostgreSQL SELECT 1 and, when enabled, obtains/pings Redis. It
returns HTTP 200 with status ok or degraded when dependencies return normally;
exceptions return 500. It is a dependency diagnostic with readiness-like intent,
not pure liveness and not a strict readiness gate (Redis degraded can still be 200).
Its existing error-detail and timeout behavior are not remediated here.

**Checked-in configuration only:** docker-compose.yml:60 probes /api/health and
checks r.ok, not the JSON status; render.yaml:12 sets healthCheckPath: /api/health.
These establish repository intent, not deployed state. No deployed probe URL,
restart policy, thresholds, traffic removal or load-balancer configuration was
inspected. Do not label /api/health a production liveness guarantee. A future
approved health contract should separate dependency-free liveness from bounded,
explicit readiness and migrate verified probe consumers. No probe config changed.

## Provider callback policy, retry and recovery

The newly added callback per-IP quotas were withdrawn because traffic volumes,
shared provider egress IPs, delivery deadlines and retry contracts were unverified.
Those quotas could reject legitimate webhook bursts or block ingestion during an
unrelated limiter outage. The old hook returned 429/503 before handler/persistence;
it did not acknowledge success, but could not itself retain or replay rejected
requests. Automatic provider retry on those responses was never established.

**Final current behavior:** callback transport/service/verifier files are identical
to HEAD. There is no new callback 429/503 from limiter Redis. Existing server body
limits (FASTIFY_BODY_LIMIT_BYTES, default 5 MiB), raw Stripe buffer parsing,
integration raw-string parsing, verifier and timestamp checks remain intact.
Authentication body caps also remain intact. Request-rate/backpressure protection
on callbacks is outstanding; no removed quota is represented as still enforced.

Payment routes await handleProviderWebhook before returning its provider payload.
That service resolves context, calls the provider adapter's verifyWebhook, then
awaits a Prisma transaction persisting paymentWebhookEvent and any mapped intent
transition. The response follows that transaction; a thrown persistence error
uses the existing error response rather than a new successful acknowledgment.
Provider-specific failure responses can use HTTP 200 with a failure payload, so
HTTP status alone is not proof of successful processing. Existing payment
idempotency/concurrency and sensitive-header retention gaps remain unverified or
unresolved; none are certified fixed by this phase.

Integration routes return 202 for accepted, 200 for duplicate, 400 for rejected,
and propagate unexpected persistence failures as errors. Ingestion verifies the
signature before raw/canonical storage and queue enqueue. However, source confirms
an existing recovery defect: saveRawEvent, saveCanonicalEvent and canonical queue
enqueue are separate writes. hasProcessed only checks that a raw row exists, not
whether canonical/queue writes completed. A later failure can return an error;
a retry can then return duplicate without completing those missing writes. This
is not proof of processing, and safe automatic replay/recovery is not established.
The unique-conflict path also returns duplicate broadly. No change here adds or
endorses acknowledgment of an unpersisted event as processed.

Actual provider schedules, supported retry status codes, retry windows, manual
redelivery and partner configurations were not inspected. Source alone cannot
promise retry or recovery. A later fix needs durable atomic acceptance (raw,
canonical and queue/outbox state), duplicate checks against that durable state,
idempotent recovery and provider-specific tests. Operators would need an approved
reconciliation/redelivery procedure for partial records; do not blindly replay or
edit them. No callback business flow or existing data was changed in this phase.

## Bootstrap entry points: inspected, not executed

| Entry | Source establishes | Remaining gap |
| --- | --- | --- |
| bootstrap:erp-access / start:bootstrap:erp-access | package.json runs src/scripts/bootstrap-erp-access.ts or its dist output as a standalone CLI. It creates/resolves CP_ROOT, syncs permissions, creates/reuses a system owner role, creates/reuses a configured email user and binds active membership/company scope. HTTP startup does not import it. | No explicit consumed one-time guard or security audit; multi-step writes are not atomic; partial execution and concurrent bootstrap are not proven safe. Existing email identity is reused without a new ceremony, suspended membership can be reactivated, and system-owner permissions are broad. Raw error logging remains a risk. |
| bootstrap:support / start:bootstrap:support | Standalone support configuration seeding. Explicit SUPPORT_BOOTSTRAP_COMPANY_ID or CP_ROOT/first-active-company fallback; upserts queues/rules/SLA policies. | Explicit ID is returned without ownership verification; fallback chooses a company. No one-time/audited ceremony or whole-operation transaction, and reruns update configuration. Does not create human accounts. |
| seed:permissions / start:seed:permissions | Standalone CLI calls seedSystemPermissions, upserts permissions and grants all stored permissions to system owner roles. | Repeated broad privilege expansion, no grant ceiling/audited ceremony, not one atomic seed. Does not create human accounts. |
| docker-entrypoint.sh | Does not invoke these bootstrap commands; by default it can run prisma migrate deploy before its command. Dockerfile starts dist/src/index.js. | Runtime flags/deployed behavior unknown. Do not use the application image/compose stack for isolated Redis testing. Nothing was executed. |

All CLI source is unchanged. Repeated upserts are not proof of a one-time,
transactionally consumed, audited bootstrap. These gaps remain later work and are
not a reason to redesign or execute bootstrap to complete this HTTP containment.

## Unresolved privilege and architecture risks

### Retained release gates — no production-readiness claim

Completion of this containment milestone and its local commit do not clear the
following gates. External source review is not integration or deployment evidence.

| Release gate | Remaining requirement / evidence gap |
| --- | --- |
| Redis limiter lifecycle and backpressure | Bound aggregate in-flight/pending work, reconnection/retry lifetime and teardown under outages. An HTTP 503 or timeout is not proof that commands, connections or retries stopped. Late/replayed counters and recovery need an approved policy and validation. |
| Real Redis validation | Actual Lua atomicity, TTL/repair, ACL initialization, shared multi-process limits, outage/recovery and noeviction/OOM behavior remain unexecuted. The isolated harness and revised procedure were prepared and exported externally; static checks passed, but no image was pulled, container started or Redis connection opened. An exact image digest remains unverified. The external harness bundle is excluded from this commit and still requires separate execution authorization. |
| Existing role/scope escalation | PATCH access updates, role-management grants and the retained administrative creation service lack proven actor-aware grant ceilings and typed scope ownership. Denying the creation HTTP endpoints does not fix all administrative privilege escalation. |
| Tenant isolation | CompanyMembership is partial compatibility enforcement; Tenant/TenantMembership are target architecture. Warehouse ownership/scoping, cross-tenant references, pagination and complete tenant-bound negative/integration evidence remain outstanding. |
| Sessions and realtime | Refresh rotation/reuse concurrency, revocation/cache consistency, realtime membership binding and connection/event resource limits remain unresolved. |
| Financial and provider workflows | Previously recorded financial invariants, payment idempotency/concurrency, sensitive-header retention and non-atomic integration raw/canonical/queue acceptance and duplicate recovery remain unresolved or unverified. Callback backpressure and provider retry/redelivery contracts are not established. |
| Operational and consumer assurance | Dependency advisories, PostgreSQL evidence, deployed proxy/network/Redis controls, liveness/readiness probe contracts, Redis durability and frontend/driver runtime compatibility remain unverified. Preserved dist is not a reviewed deployment artifact. |
| Bootstrap and privilege seeding | One-time guards, protected audit, atomicity/concurrency, identity reuse/reactivation and broad repeated permission grants remain later work. Bootstrap was not executed; redesign is not required to close this narrowly bounded HTTP containment milestone. |

All other previously recorded blockers in this report and the approved security
architecture remain open; this list does not waive or supersede them.

PATCH /api/auth/:id still reaches updateUserAccessByCompanyAdmin. Role/scope changes
lack actor-aware grant ceilings and typed ownership validation. POST /api/auth/roles
still accepts permissions/isOwnerRole behind role.bindPermissions without a proven
ceiling. Their existing authorization conditions do not prevent every escalation.
The retained administrative service must not gain a new caller without redesign.
No claim that administrative privilege escalation is fully fixed is made.

Warehouse tenant ownership/scoped queries/pagination, session rotation concurrency,
revocation/cache consistency, tenant schema, financial invariants, realtime scope,
callback recovery/header retention, dependency advisories and infrastructure
verification remain release risks. Database and client-runtime evidence are absent.

Deployment is not authorized. Future rollout must separately verify shared Redis
ACL/TTL/no-eviction/durability and identical secrets/prefix/environment/policy on
replicas, proxy topology, outage behavior and client handling. Redis outages must
continue denying identity/session issuance; never restore a local production
fallback. Late timed-out commands may consume counters but cannot run rejected
business handlers. Rollback must retain both enrollment denials and safe response
projections; correct configuration or forward-fix instead of restoring unsafe paths.
No schema/data rollback is needed. Build reviewed source separately; preserved dist
is not the Phase 0A deployment artifact.

## Exact continuation validation

Executed in the backend worktree, without dotenv-backed application startup:

```powershell
.\node_modules\.bin\jest.cmd --runInBand --detectOpenHandles --runTestsByPath tests/security/abuseRateLimit.test.ts tests/security/auth.phase0a.test.ts tests/security/warehouse.phase0a.test.ts tests/redis/redis.config.test.ts tests/integrations/hmac-webhook.verifier.test.ts
.\node_modules\.bin\tsc.cmd --noEmit --pretty false
git -c core.safecrlf=false diff --check
git -c core.safecrlf=false diff --exit-code HEAD -- src/index.ts src/modules/payments-core src/modules/integrations-core src/scripts package.json package-lock.json docker-entrypoint.sh Dockerfile docker-compose.yml render.yaml
```

Results: Jest exit 0, **5 suites / 55 tests passed**, 24.393 seconds, no open-handle
diagnostic. TypeScript exit 0, no diagnostics, no emitted files. diff --check exit 0.
The unchanged-source comparison exited 0. Existing Redis-config test logs its
expected disabled-client warning; this is not evidence of production fallback.

The previous turn passed 64 tests. This continuation removed 15 synthetic tests for
the intentionally withdrawn public limiter, added three net auth cases, and ran
three existing HMAC cases: 64 - 15 + 3 + 3 = 55. Retained authentication/warehouse
controls were not weakened to obtain a pass.

**Source evidence:** full route/account/bootstrap searches; root instructions and
architecture; Prisma models; real frontend consumers; source health/probe and
callback persistence paths; exact unchanged-source comparisons. Initial rg calls
with wildcard directory operands failed on Windows; reruns used actual directories
and include globs. These search errors are not validation failures or evidence.

**Unit/in-process evidence:** 48 security cases cover enrollment denial, valid
inviter session preservation, system/foreign scopes, no business service/DB/session
work, actual bcrypt/JWT login/refresh against mocked DB, nested response canaries,
proxy behavior, limits and failures. Four existing Redis-config and three HMAC
verifier cases passed. No live provider or business database test ran.

**Mocked Redis evidence:** EVAL invocation/result validation, connect/eval deadlines,
two simulated instances sharing a synthetic store, bursts, local saturation,
expiry and production fail-closed behavior. No actual Redis EVAL or multi-process
Redis concurrency was executed. See Phase_0A_Redis_Test_Procedure.md for the proposed,
unexecuted initial procedure. A later concrete harness, revised procedure and
source/import review were exported in the external Phase_0A_Redis_Review.txt;
preparation is complete, execution remains unauthorized and unverified. The
external review supersedes the initial proposal for that proposed harness only.

**Unavailable/not run:** real PostgreSQL/Redis, AWS, deployed infrastructure,
bootstrap, migrations, full application startup, frontend/driver runtime, full Jest
suite (contains real PostgreSQL smoke test), build into dist. No lint script/config
exists; no linter was added. No dependency installation or advisory remediation.
Installed/locked Fastify 5.8.5 and ioredis 5.10.1 on Node 22.13.0 were reused. No
fresh whole-repository advisory assessment was performed; existing advisory risks
remain unresolved.

### Validation reused for local milestone closure

Before the report-only closure update, SHA-256 comparison against the retained
Phase 0A review manifest matched all 16 reviewed public files, including every
changed source, test and configuration example. No tested implementation changed
after the recorded successful run. Accordingly, the **5 suites / 55 tests passed**
and successful **tsc --noEmit --pretty false** results above are reused; unchanged
tests and type checking were not rerun. Harness preparation occurred outside the
repository and did not change the tested source or dependencies.

The authorized local commit is restricted to the explicit 16-file inventory below,
with this report updated to retain the release gates. Its exact staged diff is
reviewed for scope, whitespace and secrets before committing. No dist, private
files, external harness artifacts or unrelated changes belong in that commit.

## Complete changed-file inventory against HEAD (excluding dist/private files)

Previously tracked implementation changes (8 files, against the review base):

- .env.example
- .env.docker.example
- .env.production.example
- src/config/env.ts
- src/modules/identity-access/application/auth.service.ts
- src/modules/identity-access/transport/fastify-routes.ts
- src/modules/warehouse-core/application/warehouseRepo.ts
- src/modules/warehouse-core/transport/fastify-routes.ts

New files (ordinary git diff omits these):

- src/shared/http/abuseRateLimit.ts
- src/modules/warehouse-core/application/warehouseProjection.ts
- tests/security/abuseRateLimit.test.ts
- tests/security/auth.phase0a.test.ts
- tests/security/warehouse.phase0a.test.ts
- tests/security/fixtures.ts
- docs/security/Phase_0A_Implementation.md
- docs/security/Phase_0A_Redis_Test_Procedure.md

The previous publicAbuseLimits.ts and publicAbuseLimits.test.ts were new in this
phase and have been removed intentionally. src/index.ts was returned to HEAD by
removing only the two Phase 0A hook lines. No unrelated file was reverted.

The review package provides a complete unified diff against HEAD including additions,
and a separate full-content document for all six newly added source/test files.
Only the explicit public-file inventory above is exported. Private environment
files, credentials, dist and unrelated ignored/untracked files are excluded.
Public .env.*.example changes contain configuration examples, not private env files.

All 243 dist files matched original, continuation and harness-preparation SHA-256
plus modification-time snapshots. Those unchanged scans are not repeated for this
report-only closure. This report accompanies the explicitly authorized local
Phase 0A commit; it does not authorize pushing, deployment, database/Redis/AWS
access, bootstrap or execution of the external Redis harness. Production
readiness is not established.
