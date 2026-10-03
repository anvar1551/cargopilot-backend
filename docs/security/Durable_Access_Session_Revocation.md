# Durable access/session revocation

Baseline1aaa780 verified, saved backlog notes and dist preserved. Confirmed gap:
access JWTs lack durable SID; fresh membership HTTP/Socket.IO checks cannot
detect logout/password revocation. Three protected emitters broadcast to a
selected membership room without checking each connected session.

Plan before implementation: reuse UserRefreshSession identity/immutable lineage.
Generate the refresh record first inside the existing accepted transaction and
sign access SID from that record. No new schema or parallel family model.
Validate signed purpose, complete UUID context, finite JWT expiry and SID; use
one bounded recursive PostgreSQL read (at most257rows) and exact active selected
membership/company/tenant bridges. Validate every recorded predecessor/depth/link
and require a live unexpired terminal session. Normal rotation preserves existing
access until JWT expiry through recorded successors only. Logout of an original
or intermediate refresh and atomic password cleanup revoke the live terminal,
therefore older bound access is denied too. Missing/corrupt/legacy/unlinked
authority fails closed. No timestamp inference or positive authorization cache.

HTTP still applies existing company/object/action checks. Socket authentication
retains SID and JWT expiry. Protected emits validate each exact local recipient
session immediately before direct socket delivery, preserving event payloads,
membership rooms and current recipient resource/permission checks. No room-wide
protected broadcast and no Redis authorization. Notifications persist under
their existing durable source authority independently of online session presence.
Bounded periodic checks disconnect idle revoked/expired/ineligible sockets;
database errors deny delivery/disconnect rather than use cached authority.
Limits:1024connections/process,64checked sockets/batch,4parallel checks,
single non-overlapping5second sweep using a finite snapshot (no churn starvation).
32pending lineage reads/process; capacity denial occurs before database admission.
Read transactions2second admission,
5second statement/10second transaction deadlines. No claim of uniform5second
revocation SLA under load/failure. Future Socket.IO cluster adapters must preserve
individual authorization; current source uses local process sockets only.

Compatibility: login/refresh response fields unchanged; new signed access sid
claim. Legacy access requires fresh login; bound refresh can issue new tokens.
No client edits; actual browser/device compatibility remains deferred. Expired
JWTs cannot remain connected indefinitely. Mixed old issuers/consumers cannot
provide this guarantee; deploy uniformly, rollback preserves enforcement or
contains auth/delivery. No database migration or historical data changes.

Validation plan: affected signing/HTTP/socket mocks; actual disposable PostgreSQL
issued tokens/lineage/logout/password/revoked/foreign/expired graph and rollback;
real loopback WebSocket Socket.IO protocol using installed ws (socket.io-client
unavailable), two independent backend processes sharing only the disposable DB.
Assert existing revoked sockets cannot receive protected events while independent
roots/tenant/company remain eligible. Poll/disconnect timing evidence separate
from per-event checks. No external services, credentials, dependency installs,
clients, dist writes or broad audit. Later audit/dependency-ready tasks remain.

Revocation boundary: requests or deliveries whose final check precedes a
concurrent commit can complete; this read check does not hold database locks
over HTTP handlers or network emits. No exactly-once or instantaneous distributed
revocation claim. Evidence and observed limits recorded after execution.

## Current enforced behavior and evidence

SID issuance, bounded recursive ownership/lineage reads, HTTP and connection
gates, individual delivery and finite periodic sweep are implemented. Every
session check reads PostgreSQL without a positive cache. Snapshot/action checks
remain fresh; no permission expansion. Normal rotation retains access only
through the exact accepted chain; JWT and terminal refresh expiry are checked.
Historical links are not repaired. Membership/permission changes after the final
read can race an in-flight request/delivery. Idle sweep checks current context
and session; removal of one permission need not disconnect an otherwise active
idle socket until that protected delivery. No cluster adapter is configured.

Affected milestone Jest --runInBand --runTestsByPath suites access-session,
tenant-session-auth,tenant-realtime-routing,auth.phase0a,delegation-containment,
warehouse.phase0a passed121cases. Added admission case passed separately (8
matching prior denial cases also ran, not new). After finite-sweep correction,
the two affected access/realtime suites passed37cases.122distinct current unit/
HTTP/mock cases overall,29new (26session boundaries and3individual emitter
cases). Three older HTTP fixtures use valid synthetic UUID/SID/expiry and
explicitly mock the durable database gate; their evidence remains mocked.
Final node node_modules/typescript/bin/tsc --noEmit passed. Unchanged business
suites, schema validation and generation were not repeated.

Actual PostgreSQL full99chain: run847940cc24b7 passed22affected rotation/
credential/logout and4new access/HTTP cases; one transport fixture failed because
the persistence adapter intentionally omits roles. Two idle transport cases
passed. Corrected explicit synthetic driver role/membership grant/assignment,
without an application override. Final c9ae49681282 passed3affected transport
cases,26unchanged skipped. Seven distinct new PostgreSQL-backed cases, not
rerun totals. First e6da72d1d2d3 applied99migrations but executed zero cases
because test Permission.resource/action were missing; corrected, not evidence.

Real loopback transport uses installed ws, Engine.IO4/Socket.IO websocket packets
and actual Server middleware/emits/close. socket.io-client is unavailable; no
dependency installed. Two independent Node processes load actual source through
installed ts-node and share only the guarded disposable DB. Prisma configuration
is replaced before evaluation; no dotenv/application workers/Redis/AWS/providers.
Issued access survives normal rotation; original/intermediate successor logout
denies HTTP/existing sockets while a separate root still receives the event.
Password change disconnects idle sessions in both processes without a business
emit. JWT expiry disconnects and legacy access cannot connect. Socket-close
assertions use7.5second deadlines at low load, not a production latency guarantee
or deployed cluster proof. Foreign tenant/company/user/SID, expired/suspended
owner graph and password cleanup deny HTTP without handler/business effects.
Actual rollback/concurrency cases reran because signing order changed; passed.
Storage/providers/browser/device clients remain unverified.

Owned e6da72d1d2d3,847940cc24b7,c9ae49681282 used cached PostgreSQL16 --pull
never, synthetic loopback credentials/environment allowlist,512MiB/1CPU/128PIDs/
256MiB tmpfs. Exact names/run labels/no volume-bind/owned storage checked before
removal, filtered absence verified. Websocket processes/connections close in
finally with bounded startup/IPC/operation/cleanup and diagnostic capture. No
existing services, dependency/client/dist edits. Source limits do not prove
production pool/Redis/cluster guarantees; existing membership snapshot queries
retain their client pool behavior and do not gain a uniform revocation SLA.
