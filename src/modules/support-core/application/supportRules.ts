// Contained: legacy global rule scanning cannot supply a durable accepted source.
// Re-enabling requires a specific server-owned operation contract, not payload ownership.
export async function runSupportAutoTriage(_reason = "manual") { return; }
export function startSupportRulesWorker() { return; }
