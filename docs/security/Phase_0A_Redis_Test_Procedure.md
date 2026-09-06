# Proposed isolated real-Redis verification — not executed

## Scope and authorization

This is a procedure for later review, not evidence of a passing Redis integration
test. No container, Redis client connection, database, AWS resource, image pull,
dependency installation or infrastructure inspection was performed for it.
Execution requires separate authorization for the exact disposable resources.
Never use CargoPilot's compose stack: its entrypoint can run Prisma migrations.

Test only the production `createAbuseRateLimiter` and Fastify hooks from reviewed
source. Do not start src/index.ts, import prismaClient, load dotenv, run bootstrap,
connect to PostgreSQL, or use any existing Redis endpoint/credentials. The HTTP
handlers in this harness are synthetic and only increment an in-process counter;
they do not call authentication or business services.

## Isolation prerequisites

1. Select and review an official Redis image at an exact immutable digest before
   running it. Record version/digest, architecture and advisory assessment. No
   image/version is asserted safe or already available by this document.
2. Choose a unique disposable container name and ownership label, a unique random
   test prefix, and a free loopback-only port (for example 16379). Verify that
   these identify new test resources; abort on conflicts. Do not attach volumes,
   existing networks, host networking, existing credentials or production data.
3. Run a standalone Redis container with no persistence (`--save ""`,
   `--appendonly no`), bounded container memory/CPU/PIDs and Redis maxmemory
   (for example 32 MiB with `noeviction`). Publish only `127.0.0.1:<test-port>`.
   Use a new synthetic ACL user limited to `<run-prefix>:*` and the commands the
   harness needs: PING, EVAL, INCR, PEXPIRE, PTTL, GET and prefix-scoped inspection.
   Do not publish an unauthenticated Redis listener beyond loopback. Review the
   container command and generated ACL file as a concrete prerequisite.
4. Launch the test harness with a clean child-process environment, not a copy of
   `.env` or the parent process's Redis variables. Supply only required runtime
   paths and synthetic test configuration. Refuse to connect unless the URL host
   is exactly 127.0.0.1, the port matches the verified disposable container's
   published port, and the container ID/ownership label matches this run.
5. Both worker processes use NODE_ENV=production, the same newly generated
   synthetic HMAC secret (at least 32 characters), and the same run-specific
   REDIS_RATE_LIMIT_PREFIX. Set RATE_LIMIT_LOCAL_FALLBACK_ENABLED=false explicitly.
   Their REDIS_URL refers exclusively to that container, with the synthetic ACL
   identity. REDIS_ENABLED=true. Never print the secret, full URL or ACL password.
6. Use the repository's already-installed TypeScript runtime (ts-node from the
   current dependency tree, if present and verified) for an isolated temporary
   harness. Alternatively compile the harness and required limiter source to a
   new verified temporary directory, never tracked dist. Do not install anything.
   The harness files must themselves be reviewed before execution.

## Harness design

- Start two independent Node worker processes, each importing the actual
  src/shared/http/abuseRateLimit.ts and src/config/redis.ts. Each instantiates its
  own default production limiter with no injected sharedStore/localStore.
- Exchange test commands/results over IPC; each worker also creates a Fastify
  instance with a synthetic POST route using the actual limiter hook. Use
  Fastify.inject so no additional HTTP listener is required.
- Use synthetic identifiers such as `principal:alice@example.test` and purpose
  `phase0a-redis-burst`. The only permitted Redis keys begin with this run's prefix.
- Record counts, decisions, elapsed time, response status and sanitized errors.
  Inspect key names for absence of raw identifier strings without dumping values
  or credentials. Assert the hook never invokes the synthetic business handler
  after a rejected decision. Counters used for security limiting are permitted
  security effects, not business effects.
- Capture container ID/image digest, Node/ioredis/Fastify versions, source HEAD
  plus focused diff hash, sanitized test settings, timestamps and exact results.

## Test matrix and acceptance criteria

| Case | Procedure | Required result |
| --- | --- | --- |
| Shared atomic burst | Concurrently submit 100 consumes, split between both processes, using one key, limit 20 and a 30-second window. Finish within the same window. | Exactly 20 allowed across both processes, all others denied, count reflects all consumes, backend shared. A per-process allowance of 20 each fails. |
| Route enforcement | Drive synthetic HTTP requests below and above that policy on both workers. | Allowed requests call the handler; excess requests return generic 429 with Retry-After and no handler effects. No principal remaining-count header. |
| Expiry | Separate purpose with one-second window; inspect PTTL, wait past expiry, then consume again. | Positive bounded TTL, counter resets after expiry, no permanent key. Use real time rather than Jest fake timers. |
| TTL repair | With an isolated test-admin identity, seed only a known run-owned limiter key with a positive counter and no expiry, then consume. | Counter advances and TTL is repaired. Never modify keys outside this run. |
| Key separation/privacy | Vary identity and purpose; start a third worker with a different environment/prefix but otherwise synthetic settings. | Independent counters; same environment/purpose/identity/secret/prefix reproduces the same key across processes. No raw email, token or IP in Redis key names. |
| Missing backend | Stop only the verified disposable container while workers remain alive. Submit HTTP requests to both. | Generic 503 within the configured deadline plus scheduling tolerance (target <= 1.5 seconds), no business handler call, no local allowance. |
| Stalled command | Pause only that container for a short bounded interval, submit requests, then unpause in a finally block. | One-second limiter timeout fails closed. Late command completion may consume a counter, but the rejected handler never runs later. |
| Recovery | Restart/unpause the same isolated test resource, wait for existing client cooldown/reconnect, then retry. | Shared limiting resumes after Redis readiness; no manual production fallback. Restart with disabled persistence may reset counts; record this limitation explicitly. |
| ACL failure | In a separate isolated run remove EVAL permission from the test identity. | Generic 503; no fallback or handler effect. Restore only the disposable ACL fixture for subsequent cases. |
| Invalid stored type | Using the test-admin identity, put a wrong Redis type at one known run-owned key. | EVAL error becomes fail-closed 503; no business action. Let its bounded TTL expire or remove that exact owned key. |
| Capacity policy | Fill only the disposable instance's run-owned namespace within approved memory bounds until noeviction returns OOM. | New counter creation fails closed. Active counters are not silently evicted to grant fresh allowances. No stress on any shared service. |
| Production configuration | Start a worker with local fallback enabled, and another without a valid shared secret. | Configuration rejects; neither starts accepting test requests with local counters. |

For burst tests, a window rollover invalidates the run rather than relaxing the
expected count. Redis restart or failover durability is not proven by this test;
the no-persistence restart deliberately demonstrates why real deployment policies
must be reviewed separately. This procedure does not prove TLS, network isolation,
provider retry behavior, authentication DB semantics or warehouse tenant isolation.

## Teardown and evidence

Close Fastify instances and IPC workers; stop/kill only the child PIDs created by
this harness. Always unpause the owned container in cleanup. Before removal,
recheck its exact ID and ownership label. Remove only that disposable container
and reviewed temporary harness/ACL files. Do not use FLUSHALL, FLUSHDB, wildcard
deletion, compose down, or any operation on an existing database/Redis instance.

Compare dist fingerprints, repository status and dependency files to the baseline.
Publish a sanitized result table that separates real Redis EVAL/concurrency/TTL
evidence from the already passing mocked tests. Any unavailable case remains
unverified; do not claim an integration pass merely because the harness starts.
