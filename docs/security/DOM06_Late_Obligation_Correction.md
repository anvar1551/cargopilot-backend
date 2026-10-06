# DOM-06 late-obligation correction

Baseline: eeeec82d76357f38613dc416d0f1f1691e921fd0.
Bounded execution plan: (1) reproduce zero-to-positive SENDER after pickup,
RECIPIENT after delivery and late initial binding/first acceptance through actual
authorized services with independently approved synthetic state eligibility;
(2) reject new CASH binding after its deadline and positive obligation publication
outside the same deadline under the existing Order lock, after historical retry
resolution; (3) preserve zero publication/historical receipts, demonstrate both
Order-lock acquisition schedules, assert rollback of financial graph, run affected
unit/PostgreSQL and no-emit checks, review and commit locally.

No new policy, permission, schema, accounting, merchant COD or client contract is
introduced. Sender deadline is picked_up; recipient deadline is delivered.
Exception/return/correction states do not imply a reopened collection window.
Zero revisions remain noncollectible. Timely instructions without a first accepted
basis already block the applicable transition; there is no deadline bypass there.

## Verified finding and correction

Four distinct unsafe scenarios were reproduced against unchanged baseline services:
zero sender after pickup and zero recipient after delivery both accepted a positive
revision; a newly created free order with no instruction could cross either deadline,
then bind CASH and accept its first positive price. Prerequisites used actual controlled
provisioning, independent policy approval and normal order/assignment/custody entrypoints.
No direct obligation, custody or order-state inserts supplied these scenarios.

New instruction binding checks the deadline after fresh authority/ownership and matching
receipt resolution. Positive publication checks the locked, reloaded Order state in the
accepted-price transaction before collection/mirror/source/audit/pointer writes; the earlier
approval insert rolls back on rejection. No new SQL constraint or migration is needed for
this admission correction. Existing immutable source constraints remain unchanged.

SENDER allows pending, assigned and pickup_in_progress. RECIPIENT additionally allows
picked_up, at_warehouse, in_transit and out_for_delivery. Later, unknown, cancelled or
exception states reject 409 CASH_COLLECTION_WINDOW_CLOSED. These are new-authority
admission windows, not permission to collect at every listed state: the narrower actual
collection stage/assignment/warehouse checks remain intact. Zero publication does not
create collection and does not require an open window, subject to existing financial
freeze, independent approval, current-source and policy checks.

Matching instruction, initial-price and approval retries still reauthorize and return
their original receipts before new-admission checks. A new proposal is not an approval;
late positive approval rejects without changing the previously accepted authority.
No approved instruction means no inferred cash obligation: uninstructed price acceptance
is not a cash collection authorization. A timely instruction with no first accepted
basis already blocks the applicable transition; there is no reachable late first cash
publication through that path. First acceptance while the window is open remains valid.

## Focused evidence

- Baseline reproduction: 2 late revisions passed (demonstrating the defect); the first
  late-binding probes stopped at a fixture expectation of numeric zero, corrected to
  the actual normal-creation null mirror plus no CashCollection assertion. The two
  corrected initial-binding/acceptance probes then passed. Four distinct reproduced
  scenarios, not six passing cases or a clean first run.
- Affected unit suite: `node --max-old-space-size=4096 node_modules/jest/bin/jest.js
  --runInBand tests/security/service-cash-basis.test.ts`: 46 passed. Includes 23 new
  admission-window combinations and 23 existing affected service-cash checks.
- Final no-emit: `node --max-old-space-size=4096 node_modules/typescript/bin/tsc
  --noEmit`: EXIT 0. No application client generation, build output or dependency change.
- PostgreSQL final regression: 12 distinct passed / 27 intentionally skipped (39 total),
  EXIT 0, 326.256s. Actual-service suite
  `cash-capability-postgres.integration.test.ts`, with filter
  `DOM-06 deadline|DOM-06 independently approved untouched revision|DOM-06 injected publication failure`,
  using the existing guarded wrapper, runInBand and testTimeout=60000. Ten new cases
  plus two directly affected timely-revision/publication-rollback cases; unchanged
  governance/socket and other logistics/finance scenarios are intentionally skipped.
- Ten new cases: two late positive revision rejections (also proving zero revision and
  historical receipts); two late initial binding rejections; two timely first acceptance/
  missing-basis and collection guards; four deadline/publication acquisition schedules.
  The two existing revision/rollback passes are affected regression, not additional new
  cases. Baseline reproductions and reruns are not summed into the 12 final passes.
- All 122 unchanged migrations applied in each newly owned instance. Cached PostgreSQL16
  image, no pulls; unique run labels, loopback random ports, synthetic credentials,
  1 CPU/512MiB/128 PIDs and exclusively owned 256MiB tmpfs; no volume, bind or compose.
  Environment allowlist excludes existing database endpoints/dotenv. Exact name/label/
  storage ownership and post-removal absence verified for cp-verification-45ff0383063e,
  cp-verification-dbbdf3b6746f and cp-verification-7346b20cfaff. Test-only public-key
  registries removed by suite cleanup; in-memory signing keys never exported.

The race scheduler pauses a transaction only after its actual Order FOR UPDATE,
observes pg_blocking_pids for the competitor, and releases it with bounded waits.
Both acquisition orders are tested for sender pickup and recipient delivery. A
transition-first result must reject positive publication without approval/source/mirror/
finance-audit/pointer effects. Publication-first retains the open physical state and
positive obligation; even refreshed transition preflight still rejects without exact
collection. Rejected standalone operations compare the complete synthetic business,
grant/session, audit and outbox graph; injected failure exercises atomic rollback.

Reused evidence: unchanged permit/login/grant profiles, HTTP/socket revocation,
linehaul/warehouse/proof/delivery/issuance and detailed collection/concurrency tests
retain their previously stated evidence levels. Prior offline schema syntax and manual
Prisma/SQL review remain valid (schema/migrations unchanged); fresh disposable chain
execution is distinct from semantic schema equivalence. No broad suites rerun.

## Compatibility and remaining limits

Only new late CASH binding and new positive authority gain the explicit 409 error;
existing request/response fields, operation identities and permissions are unchanged.
No exception/reopening, correction/refund, merchant COD, accounting, FX or client
implementation is enabled. Late adjustments require the separately deferred contract.
Existing receipt access still requires current authorization; database-owner/schema
administrator powers are outside application append-only protections.

Actual PostgreSQL and service evidence uses synthetic configuration and mocked external
storage/providers/Redis/labels. It does not establish S3/device/distributed delivery,
production infrastructure, historical-row certification, RLS or source-to-dist provenance.
Real owner keys/credential handoff/company configuration and schema-first rollout gates
remain. No existing database or service was accessed; dist and policy-blocked cleanup
directory remain untouched. No owned disposable resources remain; no push or deployment.
