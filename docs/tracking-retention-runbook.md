# Tracking Retention and Partition Runbook

This runbook keeps `Tracking` scalable after order volume grows into millions.

## 1) Immediate retention (safe now)

Use `scripts/tracking-retention.sql` to archive old events in batches.

- Default retention target: 180 days in hot table.
- Batch size: 50,000 rows per run.
- Archive table: `TrackingArchive`.

Suggested schedule:
- Run every 15 minutes during off-peak first week.
- Move to every 5-15 minutes when write throughput increases.

## 2) Monitoring

Track these metrics:
- `Tracking` row count
- `TrackingArchive` row count
- p95 latency for `GET /api/orders/:id`
- p95 latency for `GET /api/orders?mode=cursor`

## 3) Partitioning plan (phase after stable retention)

When `Tracking` reaches tens/hundreds of millions of rows, switch to monthly range partitioning by `timestamp`.

High-level PostgreSQL approach:
1. Create partitioned parent table with same schema as `Tracking`.
2. Create monthly partitions (`Tracking_2026_02`, etc.).
3. Dual-write from app for a short cutover window OR use trigger-based route.
4. Backfill old rows partition-by-partition.
5. Swap reads to partitioned table.

Notes:
- Prisma schema does not model native partition DDL directly.
- Keep partition maintenance SQL in migrations/scripts managed by DB ops.

## 4) SLO guardrails

- Keep hot `Tracking` under ~50-100M rows for predictable index maintenance.
- Keep archive and retention jobs idempotent and batched.
- Never run full-table delete in one transaction.
