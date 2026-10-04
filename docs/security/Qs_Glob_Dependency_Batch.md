# Compatible qs/glob dependency checkpoint — 2026-10-04

Baseline `8a56ce1352672dee621b06c931629a27c38245d8`, branch
`cargopilot/erp-foundation`. DEP-NEXT-03 is the finite scope: compatible
query-encoding and glob/tooling leaves. No application, schema, API, permission,
accounting, watcher or UUID migration. Audit severity is advisory evidence, not
demonstrated exploitability. Counts include affected parent-package aggregation.

## Reviewed changes

| Actual dependency path | Before → after | Evidence / compatibility |
|---|---|---|
| Stripe 19.2.0 → qs (^6.11.0) | 6.15.1 → 6.16.0 | Actual SDK checkout form encoding, exact safe minor units and durable idempotency header; synthetic in-memory HTTP handler. Stripe uses indices/repeat serialization, not the comma-format advisory options. No provider verification claim. |
| ts-node-dev → rimraf 2 → glob 7 → minimatch (^3.1.1) | 3.1.2 → 3.1.5 | Bounded file-pattern and exclusion compatibility; affected versions absent. |
| minimatch 3 → brace-expansion (^1.1.7) | 1.1.12 → 1.1.21 | Bounded synthetic brace expansion; not exhaustive denial-of-service proof. |
| ts-node-dev → chokidar 3 → anymatch/readdirp → picomatch | 2.3.1 → 2.3.2 | Actual watcher-resolved matcher with POSIX classes and exclusions. Chokidar/braces remain unchanged. |
| Jest 30 → jest-util → picomatch (^4.0.3) | 4.0.3 → 4.0.7 | Actual Jest-resolved matcher plus affected suites. Other resolved 4.0.7 instances unchanged. |
| ts-node-dev → ts-node → diff (^4.0.1) | 4.0.2 → 4.0.4 | Actual bounded patch creation/application and conflicting patch rejection. |

qs support leaves also refresh within declared ranges: side-channel 1.1.0 →
1.1.1, side-channel-list 1.0.0 → 1.0.1, es-object-atoms 1.1.1 → 1.1.2.
Nine lock entries changed; no added/removed lock entries or direct declarations.
npm reported 38 installed packages in the local ignored installation, not 38 new
lock dependencies. No new lock install hooks; official-registry URLs/SRI checked.
Registry scripts for selected releases and installed support leaves inspected;
all install lifecycle execution disabled. Publish/test scripts were not run.

All selected versions satisfy existing parent ranges. Node 22.13.0/npm 11.3.0
used; selected engines fit the documented Node 22.12+ 22.x baseline and
Dockerfile/CI Node 22 major. Deployed patches/cold installation are unverified.
Prisma CLI/client/adapter 7.10.0, pg 8.16.3, Stripe 19.2.0, JWT, Socket.IO,
ts-node-dev and UUID lock entries unchanged. No application query-parser switch.

## Executed evidence

```text
npm explain qs minimatch brace-expansion picomatch braces diff --json
npm view <selected version> version engines scripts dependencies dist.tarball --json --registry=https://registry.npmjs.org
npm update qs minimatch brace-expansion picomatch diff --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org --fetch-retries=1 --fetch-timeout=30000
node node_modules/jest/bin/jest.js --runInBand --detectOpenHandles --runTestsByPath tests/security/qs-glob-dependencies.test.ts tests/security/payment-provider-creation.test.ts tests/security/payment-callback-binding.test.ts
node node_modules/jest/bin/jest.js --runInBand --detectOpenHandles --runTestsByPath tests/security/qs-glob-dependencies.test.ts
node node_modules/typescript/bin/tsc --noEmit
npm audit --json --registry=https://registry.npmjs.org --fetch-retries=0 --fetch-timeout=30000
npm audit --omit=dev --json --registry=https://registry.npmjs.org --fetch-retries=0 --fetch-timeout=30000
```

**46 distinct cases passed:** 6 new dependency cases and 40 affected payment
creation/callback cases. Initial combined run: 45 passed, 1 failed because the
new test treated Stripe's Headers object as a plain object. Corrected test
normalizes Headers; only the 6 new cases rerun, all passed. No weakened header
assertion or SDK/application correction. Reruns are not extra distinct cases.
Final no-emit validation passed after this correction. Payment tests use mocked
provider/database boundaries; the new actual SDK handler performs no network.
No real-provider, hostile-pattern exhaustion, full suite/build or live-service
verification. Lock review confirmed allowed paths, engines, SRI and unchanged
boundary packages. Focused staged whitespace/scope/secret review performed.

Reused unchanged Prisma offline schema/config/client compatibility and previous
9 PostgreSQL cases, recorded in Mongoose_Prisma_Dependency_Batch.md. No database,
migration or socket run: their exercised runtime packages/schema/configuration
are unchanged. Existing detailed concurrency/revocation evidence not renewed.

## Fresh audits and every remaining finding

| Audit | Before | After |
|---|---|---|
| Full | 13: 0 critical / 10 high / 2 moderate / 1 low | 8: 0 critical / 7 high / 1 moderate / 0 low |
| Production (`--omit=dev`) | 6: 0 critical / 4 high / 2 moderate / 0 low | 5: 0 critical / 4 high / 1 moderate / 0 low |

Audit exit 1 means findings remain; valid JSON returned. qs, minimatch,
brace-expansion, picomatch and diff no longer appear. Full-minus-production is
not an independent vulnerability count. Raw after JSON kept outside repository:
`%TEMP%\cp-qs-glob-after-full.json` (SHA256
`24495727867236768a1a9a862ee92f8ca904b68dcbe29986d4f543bbf9bec333`),
`%TEMP%\cp-qs-glob-after-production.json` (SHA256
`ca8f351fd7efaf1c63336543ec7e278f0bc741cbfa43e442f051f3f347f1176d`).

| Remaining audit name / severity | Dependency path and classification | Available fix and exact blocker |
|---|---|---|
| deepmerge-ts / high | prisma 7.10.0 → @prisma/config 7.10.0 → deepmerge-ts 7.1.5, exact vendor pin. CLI/config tooling, present in production installation. | Advisory GHSA-ggr8-5vv4-36mx fixes at 8.0.0; registry stable 8.0.2. Vendor pin prevents compatible leaf refresh. Need vendor release using fixed major; no override. Recursive untrusted graph reachability not demonstrated. |
| @prisma/config / high | Same path, aggregate of deepmerge-ts. Tooling, production-installed. | Same vendor dependency blocker; aggregate is not another independent exploit. Audit proposes major Prisma downgrade to 6.19.3, not adopted. |
| mysql2 / high | prisma 7.10.0 → mysql2 3.15.3 exact vendor pin. CLI/Studio tooling, production-installed; application uses PrismaPg/pg. | GHSA-3f6p-5ww8-9rcr fixed 3.22.0; GHSA-rgwj-5xj2-c3m3 affects ≤3.23.0; registry 3.24.5 outside both. Need vendor pin refresh; no override/downgrade. No current application MySQL import found; this does not certify all CLI/deployed use. |
| prisma / high | Direct production declaration aggregates @prisma/config and mysql2. | Same two vendor blockers. Audit's 6.19.3 major downgrade is not a supported compatible remediation; CLI reclassification alone would not repair installed tooling. |
| braces / high | ts-node-dev 2.0.0 → chokidar 3.6.0 → braces 3.0.3 (~3.0.2). Development watcher/script execution. | GHSA-vfj7-8cjw-p6xm affects ≤3.0.3; registry latest braces still 3.0.3, audit fixAvailable=false. No compatible leaf patch. Requires separate watcher migration. |
| chokidar / high | Same development path; aggregation of braces. Nested c12 chokidar 5.0.0 is distinct and not flagged. | Chokidar 4/5 drops this path, but does not satisfy ts-node-dev ^3.5.1. Latest 5.0.0 also requires Node ≥20.19.0. Separate watcher API/runtime/script review, no override. |
| ts-node-dev / high | Direct dev dependency 2.0.0 → chokidar → braces; used by dev/worker/bootstrap/smoke scripts. Compiled start paths do not use this watcher. | Registry latest 2.0.0 retains affected path; audit fixAvailable=false. Replacement/startup-watch migration and command validation required separately. No production-service exploit claimed from dev classification. |
| uuid / moderate | Direct production uuid 9.0.1; GHSA-w5hq-g745-h8pq concerns v3/v5/v6 supplied-buffer bounds. Current bounded src/scripts import search found no UUID-package import; Zod uuid validators/SQL casts are not package usage. | Fixed ≥11.1.1; audit suggests 14.0.2 (major, registry latest). Separate supported-consumer/removal or CommonJS/ESM/API review required; no silent major upgrade. Runtime exploitability and consumers outside current source remain unverified. |

No inferred mitigation from severity or tooling labels. Vendor-pinned findings
are distinct from the explicitly deferred watcher/UUID migration decisions.

## Finite next task and retained boundaries

DEP-NEXT-04 (not started): bounded ts-node-dev/watcher replacement review.
Trace supported dev/worker/bootstrap/smoke commands; select a supported replacement
without weakening execution/startup boundaries, or document a concrete blocker.
Completion: affected braces path absent, equivalent intended command behavior
validated without running business bootstrap/seeds, no-emit and fresh audits.
UUID consumer/removal or major migration and vendor-pinned Prisma remediation
remain separate. Existing financial/provider approval, infrastructure, device/S3,
client, historical constraints and production-readiness gates remain open.

No service/database/container created, so no disposable-resource cleanup required.
The policy-blocked directory was neither retried nor modified:
`C:\Users\Anvar\AppData\Local\Temp\cp-dependency-coverage-c87e5bd06bb04137b29a246fe3601bdb`.
dist/private/unrelated work preserved; no push/deployment. Stop after local review.
