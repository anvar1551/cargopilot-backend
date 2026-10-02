# Carrier routing ownership expansion

Current enforced expansion: rule company equals primary and populated fallback
provider company; populated template belongs to that company; populated leg belongs
to the selected template. A leg without a template is rejected. Equality targets
for provider and template already exist and are reused; only the template-leg
identity target is new. This does not establish provider capabilities, accounting
acceptance, legal classification or permission to execute a booking.

Migration `20261003020000_carrier_routing_ownership` is additive. Four foreign keys
and one check are NOT VALID: new/changed references are checked, existing rows are
not certified. Existing simple foreign keys remain intentionally. Optional fallback
absence, no template/no leg, and template without leg remain valid. Organization
tenant-null expansion is unchanged: compound company equality is not tenant cutover.
Current application guards must still reject unowned/suspended context and legacy
conflicting graphs. Unchanged-key updates need not recertify historical FK values.

Apply expansion before application cutover. No backfill or existing-data inspection
occurred. Historical certification requires separate authorized remediation and
constraint validation. Rollback must retain equivalent enforcement or disable
affected operations, never restore unscoped writes. Existing referential actions
are retained alongside new RESTRICT constraints; this is not an immutable
configuration retirement policy or a claim that all deletes are prohibited.

Public provider/routing mutations remain unavailable pending a durable immutable
configuration version/action workflow and controlled retirement. Route-template
and automatic-selector entry points remain separate bounded work. Clients deferred.

Validation: offline Prisma syntax validation and ignored client generation passed.
Focused schema/SQL source comparison verifies selected tuples, names, optionality
and actions, not complete semantic equivalence. At 90 migrations, initial owned
0253cd371904 run passed six of eight selected PostgreSQL cases; two reparent cases
hit unrelated existing sequence/code uniqueness. Removed fixture collision without
weakening FK assertions. Owned 64e4dd37b4b7 reran only those two cases, both passed.
Eight distinct current cases (two affected inventory, six new compound scenarios),
not ten new passes. Includes actual inserts, updates, same-tenant legal-entity and
cross-tenant rejection, partial bridge, transaction rollback and concurrent
reparent/insert final invariants. Both resources removed after identity/label/tmpfs
and no bind/volume checks; label-filtered absence verified. 76 affected routing
unit/HTTP cases and no-emit passed before the separate template-source slice.

Commands: installed Node with node_modules/jest/bin/jest.js --runInBand
--runTestsByPath tests/security/integration-routing-read.test.ts
tests/security/integration-routing-mutation.test.ts
tests/security/integration-provider-http.test.ts; node_modules/typescript/bin/tsc
--noEmit; %TEMP%/cp-cash-schema-check.cjs (no-dotenv config); existing guarded
%TEMP%/cp-integration-routing-ownership-run.cjs and cp-routing-correction-run.cjs,
full chain with --testNamePattern scoped to routing inventory/compound then only
the two corrected scenarios. No provider/network, historical certification or
production-readiness evidence. Native pool deadlines and isolated ownership guards
remain unchanged.
