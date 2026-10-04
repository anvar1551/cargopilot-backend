# Historical bounded dependency-security checkpoint — 2026-10-04

Superseded current dependency evidence and completed DEP-NEXT-01 are in
[JWT_Socket_Dependency_Batch.md](JWT_Socket_Dependency_Batch.md). Counts and next
task below describe this earlier checkpoint, not the current resolved tree.

Baseline: bb65c504397ea6734ae4a1c15a7020532f5952df, branch cargopilot/erp-foundation.
This is dependency evidence, not a renewed security audit or production-readiness claim.
Scope: three direct families (AWS S3, Fastify/multipart, Jest/ts-jest), compatible
transitive resolution, one demonstrated proxy configuration correction, focused tests.
No logistics feature, database dependency, schema, client or dist changes.

## Current registry evidence

Fresh official-registry commands, before and after the final lockfile:

```text
npm.cmd audit --json --registry=https://registry.npmjs.org
npm.cmd audit --omit=dev --json --registry=https://registry.npmjs.org
```

Final commands additionally used --fetch-retries=0 --fetch-timeout=30000. Both
returned exit 1 with complete JSON findings, not an unavailable audit.

| Tree | Before critical/high/moderate/low | After critical/high/moderate/low | Total before → after |
|---|---|---|---|
| Full installed tree | 2 / 54 / 28 / 2 | 0 / 21 / 8 / 1 | 86 → 30 |
| omit=dev | 1 / 19 / 27 / 0 | 0 / 15 / 8 / 0 | 47 → 23 |

Counts are npm's affected-package/aggregation findings, not distinct exploits,
advisories or independently exploitable application paths. Do not subtract totals
to claim a development-only advisory count: shared dependencies and severity
propagation differ. Production includes Prisma CLI because it is declared under
dependencies. Historical architecture/report counts are not current evidence.

Raw JSON remains outside Git in the task temporary directory. SHA-256 provenance:

| Evidence | SHA-256 |
|---|---|
| Before full | d0f117e7a7e18444cac907e3bdefe50c29f6b223737b5e07940b11e98a599ebe |
| Before production | 318fd5e1b9bae75d97dc51c077553f84dfd3ad156546f4ed51d4c46d5f0bfb02 |
| Final full | fb0ca87708314d5ab63aee3021b989e655e80fbe894524583e72f7a7897a8188 |
| Final production | 3c8830da731b99925a9eba6574690f951a9d148c3ff875e2b9b614b30d1a1b06 |

## Remediation and reachability

| Family | Resolved baseline → final | Removed affected path and evidence boundary |
|---|---|---|
| AWS S3 v3 | client-s3 3.928.0 → 3.1146.0; presigner 3.965.0 → 3.1146.0 | Old SDK XML builder → fast-xml-parser 5.2.5 removed entirely; no parser node remains. Critical GHSA-m7jm-9gc2-mpf2 and related XML advisories no longer reported. Application S3 uploads/signing/deletion establish SDK use; malicious response exploitability was not reproduced. |
| Fastify v5 | 5.8.5 → 5.12.5; multipart 10.0.0 → 10.1.2 | busboy 3.2.0 → 3.2.2; fast-uri 3.1.2 → 3.1.8 (nested 4.2.1); find-my-way 9.6.0 → 9.9.0. High schema/header/body/URL and multipart paths no longer reported. Actual HTTP/multipart reach exists; injection tests are not hostile Internet transport verification. |
| Jest/ts-jest | 30.2.0 → 30.5.2; 29.4.5 → 29.4.14 | ts-jest CLI → handlebars 4.7.8 → 4.7.9 (critical GHSA-2w6w-674q-4c4q removed). CLI compiles a static configuration template; no attacker-controlled app template shown. Babel core 7.29.7, browserslist 4.29.3 and baseline-browser-mapping 2.11.27 refreshed within permitted ranges; associated findings removed. |

Root versions are pinned; no overrides, force flag, audit fix or direct major
migration. npm explain JSON traced fast-xml-parser/busboy/JWS/socket parser/ws,
selected parents and remaining high paths; source tracing inspected SDK use,
ts-jest configuration templating, actual HTTP/proof routes, JWT verification and
realtime consumers. One oversized explain invocation timed out and is not evidence;
subsequent bounded explain commands completed. Upstream references:
[Fastify advisories](https://github.com/fastify/fastify/security/advisories),
[XML parser advisories](https://github.com/NaturalIntelligence/fast-xml-parser/security/advisories),
[Handlebars advisories](https://github.com/handlebars-lang/handlebars.js/security/advisories).

Installed release metadata (version, engines, dependencies, scripts) was inspected
using npm view against https://registry.npmjs.org before selection. Installs and
targeted updates used --ignore-scripts --no-audit --no-fund and that registry.
Inspected changed install hooks: @parcel/watcher 2.6.0 runs
`node scripts/build-from-source.js`; unrs-resolver 1.12.2 runs `node postinstall.js`.
Neither ran. Existing Prisma/SAP/native hooks were not rerun. ts-jest prepare/build
metadata was reviewed, not executed. One install failed opening package-lock.json;
a sequential retry completed. No dependency mutation ran concurrently afterward.

Final lock review: 197 added/version-changed package entries and 94 removed paths;
six changed root declarations, all within these three families. Every changed
resolved download has an official-registry URL and integrity. Exact lock entries
for Prisma/client/adapter/engines, pg/pg-pool, SAP, Redis, Socket.IO, JWT and Mongoose
remain unchanged. npm ls --depth=0 passed. Ignoring scripts worked in this installed
environment; a clean installation with native hooks on every target platform is
not proven. AWS now requires Node >=20; local Node 22.13.0 and committed node:22-slim
fit; deployed runtime is unverified. npm used 11.3.0.

## Demonstrated compatibility correction

Initial no-emit failed on numeric trustProxy (and its consequent server overload).
Installed Fastify 5.12.5 deliberately returns a deny-all trust function for numeric
hop-only settings: immediate-peer identity cannot be established by hop count.
The application now rejects numeric TRUST_PROXY at startup rather than casting it
or reintroducing insecure numeric behavior. Default false/socket IP and verified
IP/CIDR/named ranges remain. `.env.example` and the earlier Phase 0A description
are corrected. Operators using numbers must deliberately configure verified proxy
addresses; topology/headers still require infrastructure verification. No API,
custody, token or financial contract was otherwise changed.

## Executed validation

Affected HTTP/upload/callback/storage boundaries justify these suites:

```text
node node_modules/jest/bin/jest.js --runInBand tests/security/dependency-boundaries.test.ts tests/security/proof-upload-boundary.test.ts tests/security/order-child-access.test.ts tests/security/payment-callback-http.test.ts tests/security/integration-provider-http.test.ts tests/security/driver-selected-http.test.ts tests/security/support-http-containment.test.ts tests/security/configured-billing-http.test.ts
```

8 suites / 135 tests passed (95.543 s). Four new cases exercise actual Fastify false
schema/header validation, bounded multipart rejection before downstream writes,
and actual S3 immutable headers/XML decoding/presigning through a network-free
handler with synthetic credentials. No real S3/provider/storage claim.

Jest shared mocking/timer changes justify:

```text
node node_modules/jest/bin/jest.js --runInBand tests/security/abuseRateLimit.test.ts tests/security/integration-destination.test.ts
```

2 suites / 83 tests passed (38.235 s). After the proxy correction, only affected
abuseRateLimit and new dependency-boundaries suites reran: 22 passed (26.547 s).
After final Babel resolution, coverage processing reran integration-destination:

```text
node node_modules/jest/bin/jest.js --runInBand tests/security/integration-destination.test.ts --coverage --collectCoverageFrom=src/modules/integrations-core/application/integration-destination.ts --coverageDirectory=<exclusively-owned-temporary-directory>
```

65 passed (42.325 s); coverage 88.88% statements/branches, 100% functions, 94.54%
lines. This verifies the local instrumentation path, not complete destination
security. Owned temporary coverage output remains outside the repository after
automatic approval review rejected recursive Remove-Item with "blocked by policy",
including an explicit literal-path attempt. Its resolved temporary path, ownership
marker and non-reparse directory attributes were verified; cleanup is incomplete:
`C:\Users\Anvar\AppData\Local\Temp\cp-dependency-coverage-c87e5bd06bb04137b29a246fe3601bdb`.
These are **218 distinct cases**, not 305 new cases; reruns are not added again.
HTTP injection is actual Fastify, DB/auth/network/storage boundaries are mocked.
Final `node node_modules/typescript/bin/tsc --noEmit` passed after correction.
No emitting build, PostgreSQL, Redis, migration or application startup ran.

Reused unchanged custody/PostgreSQL/concurrency/real Socket.IO evidence only for
unchanged source/schema/dependency boundaries. This is not new transport or
database evidence after upgrades. dist remains preserved and not rebuilt.

## Remaining current findings and finite next task

| Current path | Existing evidence/limit | Next requirement |
|---|---|---|
| jsonwebtoken 9.0.2 → JWS 3.2.2, high GHSA-869p-cjfg-cm3x | JWT verification is used by login/HTTP/realtime; selected context/revocation checks do not remove a signature-library defect. Exploit not demonstrated. | Compatible JWS resolution plus affected signing/verification/session regression. |
| Socket.IO 4.8.3 → engine.io 6.6.6 / parser 4.2.6 / ws 8.18.3 | Actual inbound transport; tenant routing does not eliminate parser/resource advisories. | Compatible parent/transitive patches and isolated real transport checks. |
| Prisma 7.2.0 → Hono/node-server, AST/lodash, config/effect/deepmerge, mysql2; defu via CLI config | Production-manifest tooling, not demonstrated runtime HTTP reach. Client/pg adapter paths unchanged. | Separately reviewed matching 7.x tooling/client plan. Audit suggests major downgrade to 6.19.3: not adopted; no claim that all compatible 7.x fixes are impossible. |
| Mongoose 8.18.3 high | Installed production package; no imports found in current src/scripts. Reachability not established. | Review whether removal is valid, or compatible patch plus affected consumers. |
| ts-node-dev/chokidar/braces, minimatch/brace-expansion; Jest picomatch 4.0.3 | Development glob/watcher paths. Braces audit fixAvailable=false. | Separate compatible leaf review; watcher replacement if required, no speculative override. |
| qs/valibot/uuid and low diff plus aggregate parents | Current JSON distinguishes direct advisories from propagated severity. uuid audit proposes major 14 upgrade. | Reachability/API review before remediation; no automatic major migration. |

**DEP-NEXT-01 (not started):** next finite batch should remediate the JWT and
Socket.IO production high paths with compatible, inspected official releases.
Completion: remove affected JWS/engine.io/parser/ws versions across the resolved
tree; preserve exact tenant/session authorization and revocation; pass focused
token/HTTP and isolated real socket tests, no-emit and fresh full/production audit;
review/commit locally. Review lifecycle hooks and verify disposable cleanup.
Do not reopen unchanged logistics or invent accounting/FX/approval policy. Remaining
dependency findings, native/runtime/platform verification, source-to-dist and all
existing finance/provider/history/client release gates stay open.
