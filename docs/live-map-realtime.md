# Live Map Realtime API (Phase 1)

This phase adds production-safe backend primitives for manager live tracking:

- Snapshot API for initial map data
- Driver location ingest API
- SSE stream for realtime updates
- Redis-backed state with in-memory fallback

## Endpoints

### `GET /api/manager/live-map/snapshot`
- Roles: `manager`, `warehouse`
- Response shape matches frontend live-map contract:
  - `generatedAt`
  - `drivers[]`
  - `orders[]`
  - `warehouses[]`
  - `isMock` (always `false` in backend snapshot)

### `GET /api/manager/live-map/stream`
- Roles: `manager`, `warehouse`
- Content-Type: `text/event-stream`
- Events:
  - `ready`
  - `live-map` (`driver_location_upsert`)

### `POST /api/drivers/location`
- Roles: `driver` (or `manager` for backoffice/testing)
- Body:
```json
{
  "lat": 41.31108,
  "lng": 69.28022,
  "speedKmh": 34,
  "headingDeg": 188,
  "accuracyM": 7.2,
  "recordedAt": "2026-04-24T11:51:00.000Z",
  "orderId": "uuid-optional",
  "driverId": "uuid-optional-manager-only"
}
```

## Redis Keys / Channels

- Driver last known location:
  - `${REDIS_PREFIX}:live-map:driver-location:${driverId}`
- Live event channel:
  - `${REDIS_PREFIX}:live-map:events`

## Tunables

- `LIVE_MAP_DRIVER_LOCATION_TTL_SEC` (default: `43200`)
- `LIVE_MAP_SNAPSHOT_ORDER_LIMIT` (default: `300`)
- `LIVE_MAP_RECENT_HOURS` (default: `72`)
- `LIVE_MAP_STREAM_HEARTBEAT_MS` (default: `25000`)
- `LIVE_MAP_SNAPSHOT_RATE_LIMIT_*`
- `LIVE_MAP_STREAM_RATE_LIMIT_*`
- `DRIVER_LOCATION_RATE_LIMIT_*`

## Notes

- When Redis is unavailable, the service falls back to process memory.
- Warehouse users are scoped to their warehouse in snapshot and stream filtering.
- Status is derived from location heartbeat age:
  - `online` <= 70s
  - `idle` <= 180s
  - `stale` <= 600s
  - `offline` > 600s

