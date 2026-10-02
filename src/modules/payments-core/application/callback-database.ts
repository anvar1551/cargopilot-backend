import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

export const callbackDatabaseLimits = Object.freeze({ max: 8, connectionTimeoutMillis: 1000,
  options: "-c statement_timeout=3000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000" });

/** Separate bounded pool; construction does not connect or load dotenv/application startup. */
export function createPaymentCallbackDatabase(connectionString: string) {
  const pool = new Pool({ connectionString, ...callbackDatabaseLimits });
  // Idle socket errors must not crash the process or log credentials/driver details.
  pool.on("error", () => undefined);
  const db = new PrismaClient({ adapter: new PrismaPg(pool) });
  return { db, pool, close: async () => { await db.$disconnect(); await pool.end(); } };
}

let current: ReturnType<typeof createPaymentCallbackDatabase> | undefined;
export function getPaymentCallbackDatabase() {
  if (!current) {
    // PostgreSQL deadlines cannot be claimed for an Accelerate transport.
    if (process.env.PRISMA_ACCELERATE_URL || !process.env.DATABASE_URL?.trim())
      throw Object.assign(Error("Bounded PostgreSQL callback transport unavailable"), { statusCode: 503, code: "PAYMENT_CALLBACK_DATABASE_UNAVAILABLE" });
    current = createPaymentCallbackDatabase(process.env.DATABASE_URL.trim());
  }
  return current.db;
}
export async function closePaymentCallbackDatabase() {
  const closing = current; current = undefined;
  if (closing) await closing.close();
}
