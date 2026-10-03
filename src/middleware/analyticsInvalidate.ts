/** Compatibility hook only. Covered reads are uncached; legacy global invalidation has no durable ownership. */
export async function emitAnalyticsInvalidationForMutation(_args: {
  reason: "order_mutation" | "cash_mutation";
}) {
  // Do not create an event, contact Redis, infer a tenant or acknowledge downstream processing.
  // Typed owned transactional outbox records are retained separately; rebuild/SSE remain contained.
}
