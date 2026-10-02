// No application waiting queue. An HTTP timeout/disconnect cannot release work.
const capacity = 8;
let active = 0;
export const integrationWebhookBodyLimit = 1024 * 1024;
export async function withIntegrationWebhookAdmission<T>(work: () => Promise<T>): Promise<T> {
  if (active >= capacity) throw Object.assign(Error("Webhook capacity exhausted"), { statusCode: 503, code: "WEBHOOK_INGRESS_CAPACITY" });
  active++;
  try { return await work(); } finally { active--; }
}
