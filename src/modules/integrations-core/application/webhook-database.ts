import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

export const integrationWebhookDatabaseLimits = Object.freeze({ max: 8, connectionTimeoutMillis: 1000,
  options: "-c statement_timeout=3000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000" });
/** Lazy pool construction: no dotenv, application startup or connection on import. */
export function createIntegrationWebhookDatabase(connectionString: string) {
  const pool = new Pool({ connectionString, ...integrationWebhookDatabaseLimits });
  pool.on("error", () => undefined); // Never log driver errors/credentials.
  const db = new PrismaClient({ adapter: new PrismaPg(pool) });
  return { db, pool, close: async () => { await db.$disconnect(); await pool.end(); } };
}
let current: ReturnType<typeof createIntegrationWebhookDatabase> | undefined;
export function getIntegrationWebhookDatabase() {
  if (!current) {
    if (process.env.PRISMA_ACCELERATE_URL || !process.env.DATABASE_URL?.trim())
      throw Object.assign(Error("Bounded webhook database unavailable"), { statusCode: 503, code: "WEBHOOK_INGRESS_DATABASE_UNAVAILABLE" });
    current = createIntegrationWebhookDatabase(process.env.DATABASE_URL.trim());
  }
  return current.db;
}
export async function closeIntegrationWebhookDatabase() {
  const closing = current; current = undefined;
  if (closing) await closing.close();
}
