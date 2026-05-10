# Redis + SSE Architecture Audit (Analytics, Support, Live Map)

Date: 2026-05-10
Scope: `src/config/redis.ts`, manager analytics cache/stream, support cache/stream, live-map store/service.

## Executive assessment

Current architecture is **partially modern** (Redis, lock-based stampede control, SSE, stream pub/sub), but there are several bottlenecks that will cause latency spikes as data grows.

## What is implemented correctly

1. Cache stampede protection exists via Redis NX locks in analytics/support caches.
2. TTL jitter exists for analytics/support cache entries.
3. Redis Streams are used for cross-instance invalidation/realtime events.
4. Live-map bulk reads use Redis pipeline for multi-driver fetch.

## Bottlenecks and risks

### P0 (high impact)

1. **Full-pattern invalidation with `SCAN + DEL` on each mutation**
   - Found in analytics and support invalidation helpers.
   - This is O(number of matching keys) and will become expensive with high cardinality.
   - It also adds Redis CPU pressure and can stall hot paths during mutation storms.

2. **In-process fallback memory cache causes multi-instance inconsistency**
   - If Redis is disabled/unavailable, each instance serves divergent cache data.
   - In Kubernetes/auto-scaling, this creates non-deterministic API behavior and stale data windows.

3. **Unbounded `while(true)` stream consumers without lifecycle/circuit state**
   - Consumers loop forever with fixed backoff and no abort signal/health state.
   - On partial outages, this can create noisy logs and resource churn.

4. **Live-map data model is key-per-driver hash + per-request key fanout**
   - `readDriverLocations(driverIds)` pipelines one `HGETALL` per driver.
   - For hundreds/thousands of drivers, response latency grows linearly with visible driver count and payload size.

### P1 (important)

5. **Cache invalidation strategy is coarse-grained**
   - Support invalidates list/summary/detail broadly even for localized ticket mutations.
   - Analytics invalidation clears whole namespaces rather than versioned scope keys.

6. **No explicit Redis command timeouts/latency budgets per operation**
   - Global connect timeout exists, but high-percentile reads/writes can still block request critical paths.

7. **SSE streams rely on in-process EventEmitter fanout first, Redis second**
   - Works locally, but there is no durable per-client resume support (`Last-Event-ID`) and no backpressure strategy for slow clients.

8. **Potential hot JSON serialization/deserialization overhead**
   - Large payloads are stored as full JSON strings on each cache write/read.
   - Repeated parse/stringify can dominate for analytics endpoints.

### P2 (medium)

9. **Redis keyspace schema is fragmented per feature**
   - Multiple ad-hoc key conventions and invalidation rules make operability harder.

10. **Limited observability around cache efficiency and stream lag**
   - Missing standardized metrics: hit ratio per namespace, lock contention, stream lag, invalidation throughput, and stale serve counts.

## Modernization plan (ordered)

### Phase 1: Safe, high ROI

1. Replace pattern-delete invalidation with **versioned namespace keys**:
   - Keep a version counter key per namespace/scope (`INCR`).
   - Compose cache key as `namespace:version:queryDigest`.
   - Invalidate by bumping version (O(1)) instead of scanning/deleting keys.

2. Add **strict Redis latency budgets**:
   - Wrap all Redis calls with per-op timeout (e.g., 30-80ms for read path).
   - Fail open to stale memory value for read endpoints where acceptable.

3. Add **standard metrics and tracing**:
   - `cache_hit`, `cache_miss`, `cache_stale_served`, `lock_acquire_ms`, `lock_contention`, `redis_cmd_ms`, `sse_clients`, `stream_lag_ms`.

### Phase 2: Scaling live map + SSE

4. Rework live-map storage for read efficiency:
   - Move from key-per-driver hash fanout to either:
     - Redis GEO (`GEOADD` + `GEOSEARCH`) for viewport querying, or
     - Partitioned sorted sets by geohash tiles with compact driver payload hashes.
   - This turns map fetch into area query vs N-driver fanout.

5. Implement SSE reliability features:
   - Support `Last-Event-ID` resume from stream.
   - Add per-client outbound queue limits and disconnect slow clients.
   - Separate heartbeat cadence from business event cadence.

### Phase 3: Consistency + resilience

6. Eliminate in-memory-only fallback for critical shared views:
   - Keep memory cache as L1 only when Redis healthy.
   - If Redis unavailable, mark degraded mode and shorten stale windows with explicit response headers.

7. Introduce read-model refresh workers for heavy analytics:
   - Shift expensive aggregations off request path.
   - API should read precomputed snapshots with bounded staleness SLA.

## Suggested target architecture

- L1 in-process cache (short TTL, stale-while-revalidate) + L2 Redis cache (versioned keys).
- Redis Streams for invalidation/events, with consumer groups for workers and lag metrics.
- Geo-indexed live-map state + compact incremental SSE updates.
- Strict per-endpoint SLOs and autoscaling triggers based on p95 + Redis latency.

## Immediate code-level candidates

1. `src/features/manager/analyticsV2Cache.ts` and `src/features/support/supportCache.ts`
   - Replace `SCAN+DEL` invalidation with version bump key pattern.

2. `src/features/liveMap/liveMapStore.ts`
   - Introduce GEO index path and viewport query API.

3. `src/features/manager/analyticsV2Realtime.ts` and `src/features/support/supportRealtime.ts`
   - Add resumable SSE semantics and stream health metrics hooks.

4. `src/config/redis.ts`
   - Add command timeout wrapper utilities and degraded-mode signaling.

