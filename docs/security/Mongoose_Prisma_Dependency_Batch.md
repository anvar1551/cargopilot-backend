# Mongoose/Prisma dependency checkpoint — 2026-10-04

Historical evidence for that batch. Current compatible-leaf versions, audits and
remaining paths are in [Qs_Glob_Dependency_Batch.md](Qs_Glob_Dependency_Batch.md).

Baseline 5366663d672963a3a239cc91746a393f0ef54acd, cargopilot/erp-foundation.
Finite batch: verify paths/reachability, remove unused Mongoose, compatibly align
Prisma 7, inspect lock/scripts, offline schema/config/client checks, affected
regressions and owned PostgreSQL smoke, final audits and local review/checkpoint.
No authorization, schema, accounting, logistics, client or migration redesign.

## Findings and remediation

Mongoose 8.18.3 was a direct production declaration. Searches of src, scripts,
tests, package script entrypoints, Dockerfile, README and CI found only that
declaration, with no Mongoose/MongoDB import, runtime loader or supported workflow.
It was removed instead of guessing a MongoDB contract or taking Mongoose 9.
Mongoose, mongodb, bson, mquery and kareem no longer resolve. This establishes
unused current repository source, not the contents of deployed/dirty build output.

Prisma CLI, @prisma/client and @prisma/adapter-pg: **7.2.0 → 7.10.0**, exact pins.
Engines/config/client-runtime/adapter-utils and generated client match 7.10.0.
Vendor @prisma/dev 0.24.17 intentionally contains 7.2.0 tooling components; no
override forces those internal packages to another version. Stable 7.x was selected
from official registry metadata; Prisma 8.0.0-rc.19 and the audit's 6.19.3 major
downgrade suggestion were not adopted.

```text
npm.cmd uninstall mongoose --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
npm.cmd install prisma@7.10.0 @prisma/client@7.10.0 @prisma/adapter-pg@7.10.0 --save-exact --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org --fetch-retries=1 --fetch-timeout=30000
```

Source boundaries: application prismaClient.ts uses generated Client + PostgreSQL
adapter; prisma.config.ts imports CLI config/dotenv. CLI is a production declaration,
so tooling findings appear in omit=dev. That does not prove Hono, MySQL or Studio is
reachable through backend HTTP. Studio/dev servers were not started. Updated tools
remove the previous Hono/node adapter and AST/chevrotain paths; Effect 3.18.4 →
3.20.0, defu 6.1.4 → 6.1.7, Lodash 4.17.21 → 4.18.1 remove their reported findings.
DeepmergeTS 7.1.5 and MySQL2 3.15.3 remain exact upstream pins.

Lock review: 100 added/changed package entries, 35 removed; only three Prisma root
declarations changed and Mongoose was removed. Shared dotenv 17.2.2 → 17.4.2 is
required by new config/c12 (^17.3.1); focused compatibility checks cover it. Prisma
Studio's React/PGlite and config-loader transitive changes are tooling dependencies,
not frontend changes. All changed resolved URLs are official npm registry URLs
with integrity. pg/pg-pool, Socket.IO/JWT, Fastify, Redis, AWS and Stripe/qs lock
entries remain unchanged. npm ls --depth=0 passed. No override or audit fix used.

## Engine, schema, config and client evidence

Metadata/lifecycle review preceded install: Prisma preinstall is a runtime checker;
@prisma/engines postinstall downloads its version-pinned schema engine. Installs
ignored scripts; no blanket npm rebuild. First offline validate stopped because
missing engine triggered the intentionally denied network path, not bad schema.
Inspected engine installer/fetch checksum handling; ran only that targeted installer
with an endpoint-free environment and HTTPS requests restricted to
https://binaries.prisma.sh (official mirror), no alternate host/credentials.
It may reuse its checksum-checked cache; binary --version matches engine commit
`0edf323efd1d98336f3f0a68684b56f689b900d3`. Official registry packages and this
official engine artifact are separate sources; no business/provider network used.

`node "$env:TEMP\cp-prisma-offline-check.cjs"` then passed CLI validate/generate
against an explicit synthetic config, with net/http/https/DNS/fetch denied and
dotenv/config forbidden. Schema folder is actual prisma/. Generated only ignored
node_modules client (7.10.0), no dist/build/schema edits. Original config was also
loaded by `node "$env:TEMP\cp-prisma-root-config-check.cjs"`: synthetic DATABASE_URL/
DIRECT_URL, network denied, dotenv/config replaced by empty test stub so no .env is
read. CLI accepted the actual config and schema. This does not certify deployed
endpoint/migration-role wiring or strict typing of the root config (not included
by project tsconfig). No database comparison or live connection occurs in validation.

[Prisma 7.10 release notes](https://github.com/prisma/orm/releases/tag/7.10.0)
identify adapter error/transaction cleanup changes, justifying focused real database
checks rather than reusing every old runtime result. No broad migration/concurrency
campaign repeated. Local Node 22.13.0/npm 11.3.0 fits Prisma's
^20.19 || ^22.12 || >=24.0 requirement. README now states the intended 22.12+ floor;
Dockerfile uses node:22-slim and CI selects Node 22. Their actual built/deployed patch
and native-platform images remain unverified. No Node major or Dockerfile change.

## Executed focused evidence

Actual commands (initial invocation also contained a nonexistent account test
pattern; Jest ran only the three real suites, not a fourth imaginary pass):

```text
node node_modules/jest/bin/jest.js --runInBand tests/security/order-creation-authority.test.ts tests/security/tenant-session-auth.test.ts tests/security/payment-authority.test.ts
node node_modules/jest/bin/jest.js --runInBand tests/security/prisma-config-dependencies.test.ts tests/security/account-intent.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

Three suites / 163 tests passed (45.950 s); two suites / 18 passed (38.058 s).
**181 distinct in-process cases**, including two new config/dotenv cases. These
are mocked database/provider evidence for Prisma values, financial authority,
session context and immutable normalized intents. Final no-emit passed after new
client generation and final test additions. Build/dist emission was not run.

`node "$env:TEMP\cp-prisma-dependency-run.cjs"` reused the existing disposable
resource harness, changing only selected suites/patterns. One new loopback container
`cp-verification-45fed6d4d121`, cached PostgreSQL 16 Alpine image
`sha256:20edbde7749f822887a1a022ad526fde0a47d6b2be9a8364433605cf65099416`,
--pull never, 512 MiB/1 CPU/128 pids, 256 MiB tmpfs, unique ephemeral loopback port,
synthetic credentials and cleared database environment. All 112 unchanged migrations
applied as empty disposable setup, not a renewed historical certification. The
existing harness's synthetic legacy ingress setup was retained. Separate owned
database clones/markers isolate suites within that one instance.

| Actual PostgreSQL coverage | Distinct passed cases |
|---|---|
| New upgraded-client smoke: nested tenant-owned reads/Decimal; BigInt/Decimal/DateTime/JSON parameterized round trips; P2002/P2003 plus unchanged rejected records; interactive rollback | 4 (56.479 s suite) |
| Existing direct-account concurrency and receipt/outbox-trigger rollback, actual service/transaction | 3 selected, 15 skipped (59.759 s suite) |
| Existing normal order concurrent matching retries and receipt-trigger rollback, actual service/transaction | 2 selected, 28 skipped (58.989 s suite) |

**9 distinct PostgreSQL cases**, not full-suite totals: final business records,
receipt/audit/outbox counts and rollback are asserted. Combined batch 190 distinct
cases; six new cases, remaining cases affected existing regressions. This does not
prove every adapter operation, infrastructure or exactly-once external delivery.
Ownership/name/run labels/no volume-or-bind storage verified before container removal;
run-label absence verified afterward. Cleanup confirmed, including exclusively owned
tmpfs and clones. Existing containers/databases/Redis/AWS were untouched.

Reused unchanged detailed migration/history, custody, transport/provider, payment,
chart and finance concurrency evidence outside these selected adapter-sensitive
cases. Those are historical evidence for unchanged invariants, not blanket Prisma
7.10 runtime revalidation. No policy-dependent execution enabled.

## Final audits and remaining disposition

Fresh before/final full and omit=dev JSON, official registry, fetch retries 0 and
30-second timeout; complete outputs/exit 1 denote findings. Audit counts are
affected packages/aggregation, not distinct exploits or development-only subtraction.

| Tree | Before critical/high/moderate/low | Final critical/high/moderate/low | Total |
|---|---|---|---|
| Full | 0 / 17 / 7 / 1 | 0 / 10 / 2 / 1 | 25 → 13 |
| omit=dev | 0 / 11 / 7 / 0 | 0 / 4 / 2 / 0 | 18 → 6 |

| Remaining path | Disposition |
|---|---|
| DeepmergeTS 7.1.5 → @prisma/config; MySQL2 3.15.3 → Prisma; aggregated parent highs | Exact current vendor pins. No compatible leaf update without changing parent authority. Needs upstream revised 7.x package or separately reviewed breaking tooling/dependency change; neither downgrade/override nor Prisma 8 RC taken. Deepmerge advisory requires 8.x. CLI/config reach differs from PostgreSQL runtime; exploit not established. |
| qs 6.15.1 → Stripe, moderate | Compatible fix reported; actionable next bounded review with actual outbound encoding/callback boundaries, no provider calls. Unchanged in this batch. |
| minimatch 3.1.2 / brace-expansion 1.1.12 / picomatch 2.3.1 and Jest 4.0.3, dev highs; diff low | Compatible leaf fixes reported; review exact ranges and affected watcher/glob/mock tooling. |
| ts-node-dev → chokidar 3/braces 3.0.3, high/aggregation | Audit fixAvailable=false. Maintained watcher replacement may need a reviewed tooling migration, not speculative overrides. |
| uuid 9.0.1, moderate | Audit suggests major 14.0.2. Review CommonJS/ESM and actual UUID APIs before any major migration; not silently replaced. |

SHA-256 of raw temporary JSON (not committed dumps): before full
`acad108447d80c3e21271a04b17dc3861e9d3a947dfaee71d3825f9365ff2dbb`;
before production `50a0f811fe6441cc9c046a3bf92a34e8f18b9f86fee14dedc91df0324cc144d0`;
final full `c17243e2c28fca7e27bcaff267cb93204ee56a102a8419399c27aba5eec15371`;
final production `411f183256c3bce76c67111fecd937bf116101184d677fcda4d8b9a1a8437e80`.

DEP-NEXT-02 complete. **DEP-NEXT-03 (not started):** compatible qs plus dev
glob-leaf remediation, bounded registry/script/range review, offline request encoding
and affected tooling tests/no-emit/fresh audits. Completion: selected affected versions
absent, contracts unchanged, remaining pinned/breaking paths explicitly documented.
Do not replace watchers/UUID or enable financial workflows in that compatibility batch.
All real-company/policy, provider/storage/device/Redis, historical constraints and
deferred client/release gates stay open; no production readiness or complete isolation.

Old policy-blocked directory remains untouched for manual cleanup:
`C:\Users\Anvar\AppData\Local\Temp\cp-dependency-coverage-c87e5bd06bb04137b29a246fe3601bdb`.
No push, deployment, existing-service access or application startup. dist preserved.
