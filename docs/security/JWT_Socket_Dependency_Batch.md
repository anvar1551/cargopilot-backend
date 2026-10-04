# Historical JWT/JWS and Socket.IO dependency checkpoint — 2026-10-04

Current dependency evidence and completed DEP-NEXT-02 are in
[Mongoose_Prisma_Dependency_Batch.md](Mongoose_Prisma_Dependency_Batch.md).
Counts/next task below describe this earlier checkpoint.

Baseline 74660208e8191556aecd9081d645a3f065d43772; branch cargopilot/erp-foundation.
DEP-NEXT-01 completed within the two-family scope. No product authorization,
logistics, database, client or deployment behavior was intentionally changed.

Plan executed: verify resolved paths and upstream metadata/advisories; patch only
compatible declared ranges; inspect exact lock changes; test affected token/HTTP/
refresh/logout/realtime behavior and local transport; no-emit and fresh audits;
review explicit paths and checkpoint locally. No generic dependency overrides.

## Resolved versions and path evidence

| Production path | Before → after | Audit finding removed |
|---|---|---|
| jsonwebtoken 9.0.2 → jws | 3.2.2 → 3.2.3; parent unchanged | GHSA-869p-cjfg-cm3x |
| socket.io | 4.8.3 → 4.8.4, pinned | Parent compatible patch; no major migration |
| socket.io → engine.io | 6.6.6 → 6.6.11 | GHSA-r635-g3xr-vw7x, GHSA-gr94-w7qr-f4j3, GHSA-2gc4-cqfq-p2gv |
| socket.io → socket.io-parser | 4.2.6 → 4.2.7 | GHSA-2m8v-j782-fhvr |
| socket.io → socket.io-adapter | 2.5.6 → 2.5.8 | Propagated ws finding |
| engine.io / socket.io-adapter → ws | 8.18.3 → 8.21.3 | GHSA-58qx-3vcg-4xpx, GHSA-96hv-2xvq-fx4p |

`npm.cmd explain jws engine.io socket.io-parser ws --json` verified the baseline;
the final command additionally included socket.io-adapter. JSON is outside Git.
Source confirms application use in auth.service.ts, fastify-auth.ts and realtimeHub.ts.
jsonwebtoken/verify.js invokes synchronous jws.verify with the verified key.
The [upstream JWS advisory](https://github.com/advisories/GHSA-869p-cjfg-cm3x)
explicitly excludes that interface, including jsonwebtoken consumers. No vulnerable
createVerify/header-based secret lookup was established here. This corrects the
earlier unresolved reachability classification: patching the installed version
does **not** establish that CargoPilot previously allowed this signature exploit.
Socket parser/resource exposure is real inbound transport; these tests do not
reproduce every advisory exploit or demonstrate Internet-scale DoS resistance.

Official registry version/dependency/engine/script metadata was inspected before
installation for the chosen parents and patched leaf ranges; final installed
6.6.11/8.21.3 metadata and exact lock entries were reviewed afterward. No selected
package has an install/preinstall/postinstall hook. Prepack compile scripts were
inspected, not run; downloaded registry tarballs do not require source compilation.

```text
npm.cmd install socket.io@4.8.4 --save-exact --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org --fetch-retries=1 --fetch-timeout=30000
npm.cmd update jws engine.io socket.io-parser socket.io-adapter ws --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org --fetch-retries=1 --fetch-timeout=30000
```

Exactly six installed lock entries changed and unneeded base64id was removed.
One root declaration changed (Socket.IO); JWT/JWS remains in declared 3.x, not
jsonwebtoken 9.0.3's JWS 4.x transition. All changed URLs use the official registry
and integrity hashes. No other package entries, scripts or dependency families
changed. npm ls --depth=0 passed. No lifecycle hook, emitting build or generation ran.

## Contracts and runtime requirements

Application source is unchanged: signing defaults, key-derived verification
algorithms, tokenType purpose, tenant/company/membership/session claims, fresh
eligibility checks, successor logout/password invalidation, protected recipient
checks and socket sweep remain. App jwt.verify call sites do not currently pass
explicit issuer/audience options; this batch preserves that behavior, not a claim
that app issuer/audience enforcement exists. New library tests prove explicitly
configured issuer/audience and algorithm restrictions continue to work.

No API fields, event names, selection/refresh contracts or client updates required
by this patch. Existing deferred clients and unsupported workflows remain deferred.
Old vulnerable lockfiles must not be used for builds; reinstall the reviewed lock
through the normal reviewed build process. Rollback must retain patched resolution
or contain affected exposed transport, not silently restore vulnerable dependencies.

Local Node 22.13.0/npm 11.3.0 executed the checks. README documents Node 22+;
Dockerfile uses node:22-slim for all stages; committed CI selects Node 22.
jsonwebtoken requires >=12, engine.io/socket.io >=10.2, ws/parser >=10; JWS/adapter
declare no engine restriction. No raised runtime floor in this batch. Prior AWS
>=20 requirement remains compatible with documented Node 22. Actual deployed
runtime, container contents and cold-install/native hooks are still unverified.

## Focused executed evidence

```text
node node_modules/jest/bin/jest.js --runInBand tests/security/jwt-socket-dependencies.test.ts tests/security/tenant-session-auth.test.ts tests/security/refresh-lineage.test.ts tests/security/password-session-serialization.test.ts tests/security/access-session.test.ts tests/security/protected-auth-rejection.test.ts tests/security/tenant-realtime-routing.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

Initial run: 7 suites / **134 distinct cases passed** (52.657 s). New suite: 14 cases,
comprising three actual HMAC/explicit issuer/audience/algorithm-library cases and
11 real loopback WebSocket/polling cases. The latter exercise the actual hub,
JWT verification, current membership resolver and access-session implementation
against synthetic mocked PostgreSQL responses, not mocked Socket.IO. Tenant and
same-tenant company separation; purpose/context/signature rejection; existing
socket delivery denied/disconnected after session, membership or permission
revocation; authorized polling; invalid protocol before admission. All requests
target a new ephemeral loopback server with bounded connect/request/close waits.
Sockets/server are closed; HTTP listening=false asserted. No persistent resources
created and no existing services accessed. No business mutation calls permitted.

After strengthening only new test assertions (per-connection ordering barrier for
negative delivery and explicit no-business-mutation assertion), that 14-case suite
reran: 14 passed (66.340 s); final no-emit passed again. Reruns are not additional distinct cases.
Final review identified that direct successor-revocation coverage did not prove
the signed-token logout HTTP path. Three new targeted tenant-session-auth cases
exercise actual Fastify routing/JWT verification/revokeRefreshSession with mocked
database lineage: accepted exact-context successor logout, matching retry without
duplicate audit, wrong-purpose and wrong-signature non-disclosing no-op responses.

```text
node node_modules/jest/bin/jest.js --runInBand tests/security/tenant-session-auth.test.ts --testNamePattern="JWT dependency logout HTTP contract"
node node_modules/typescript/bin/tsc --noEmit
```

Targeted result: three passed, 31 unchanged cases skipped (37.665 s); final no-emit
passed. These add three distinct cases: **137 distinct cases total**, not counting reruns.
The other 120 existing cases are mocked database/HTTP/emitter evidence for selected login,
refresh/lineage/logout/password/session revocation and protected authorization.
Transport evidence is single-process/local, not real database, Redis adapter,
multi-process infrastructure or adversarial load evidence. Pre-existing check/use
revocation race and bounded 5-second socket sweep cycles are unchanged; this does
not claim immediate revocation or exactly-once delivery.

Reused unchanged PostgreSQL rotation/concurrency/atomic-password/successor-logout
and earlier multi-process Socket.IO evidence only for their unchanged database/
application invariants. Those are not new multi-process transport results with
these dependency versions. DB dependencies/schema/queries were unchanged: no
PostgreSQL instance or migration chain was needed. Unrelated custody, finance,
pricing, codec and earlier AWS/Fastify suites were not repeated.

## Fresh audit evidence

Before and final: `npm.cmd audit --json` and `npm.cmd audit --omit=dev --json`,
each with --registry=https://registry.npmjs.org --fetch-retries=0
--fetch-timeout=30000. Each completed with findings/exit 1, not an audit failure.

| Tree | Before critical/high/moderate/low | After critical/high/moderate/low | Total |
|---|---|---|---|
| Full | 0 / 21 / 8 / 1 | 0 / 17 / 7 / 1 | 30 → 25 |
| omit=dev | 0 / 15 / 8 / 0 | 0 / 11 / 7 / 0 | 23 → 18 |

These are affected-package/aggregation findings, not exploit counts. No remaining
JWS/engine.io/socket parser/adapter/ws advisory nodes in either final JSON.
Prisma CLI/config is still in production dependencies: omit=dev does not prove
its Hono/MySQL/configuration code is served by the application. Remaining production
high paths: Prisma tooling and its Hono/node adapter/config/effect/deepmerge/lodash/
mysql2/defu paths; Mongoose 8.18.3. Remaining dev high paths include ts-node-dev/
chokidar/braces, minimatch/brace-expansion and Jest picomatch. Other current moderate
findings include qs/valibot/uuid and aggregate parents; diff remains low. No clean
dependency bill of health, complete isolation or production-readiness claim.

Raw audit JSON outside Git has SHA-256 provenance:

| JSON | SHA-256 |
|---|---|
| Before full | fb0ca87708314d5ab63aee3021b989e655e80fbe894524583e72f7a7897a8188 |
| Before production | 3c8830da731b99925a9eba6574690f951a9d148c3ff875e2b9b614b30d1a1b06 |
| Final full | acad108447d80c3e21271a04b17dc3861e9d3a947dfaee71d3825f9365ff2dbb |
| Final production | 50a0f811fe6441cc9c046a3bf92a34e8f18b9f86fee14dedc91df0324cc144d0 |

## Finite next task and manual cleanup

**DEP-NEXT-02 (not started):** a bounded Mongoose production-dependency review.
Inspect supported entrypoints/consumers to determine whether its unused declaration
can safely be removed; otherwise choose a compatible patched 8.x release, inspect
hooks and exercise actual consumers. Completion: current Mongoose high nodes absent,
no unrelated dependency changes, affected checks/no-emit and fresh audits pass or
remaining findings are precisely recorded. Prisma tooling requires its own matched
CLI/client/adapter review; the audit's major downgrade suggestion is not approval.
All existing financial-policy, real-provider/device/storage/Redis, historical
constraint, client and deployment gates remain open. No next implementation started.

The policy-rejected previous coverage directory is left untouched for manual cleanup:
`C:\Users\Anvar\AppData\Local\Temp\cp-dependency-coverage-c87e5bd06bb04137b29a246fe3601bdb`.
No retry or bypass of its removal was attempted. dist and unrelated work preserved.
