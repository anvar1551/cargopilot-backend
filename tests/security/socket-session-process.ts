// Test-only isolated process. Resolve config without executing dotenv/application startup.
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createServer } from "http";
import { Pool } from "pg";
const url = process.env.CARGOPILOT_WORKER_TEST_DATABASE_URL, run = process.env.CARGOPILOT_WORKER_RUN_ID;
if (!url || !run || !/^[a-f0-9]{12}$/.test(run)) throw Error("Disposable socket identity required");
const target = new URL(url);
if (target.hostname !== "127.0.0.1" || target.username !== "cp_worker_it" || target.pathname !== `/cp_worker_${run}`) throw Error("Refusing existing target");
async function main() {
  const guard = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 3000, options: "-c statement_timeout=5000" });
  try { const marker = await guard.query('SELECT "runId" FROM "_CPDisposableRun"'); if (marker.rows.length !== 1 || marker.rows[0].runId !== run) throw Error("Socket ownership mismatch"); }
  finally { await guard.end(); }
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 5, connectionTimeoutMillis: 3000, options: "-c statement_timeout=5000" }) });
  const config = require.resolve("../../src/config/prismaClient");
  const replacement = new (require("module"))(config);
  replacement.exports = { __esModule: true, default: db }; replacement.loaded = true; require.cache[config] = replacement;
  const hub = require("../../src/modules/realtime-core/realtimeHub");
  const http = createServer(); const io = hub.initRealtimeHub(http, ["http://127.0.0.1"]);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await new Promise<void>(resolve => io.close(() => resolve())); await db.$disconnect(); process.disconnect?.(); };
  process.on("disconnect", () => void stop());
  process.on("message", async (message: any) => {
    if (message?.kind === "shutdown") { await stop(); return; }
    if (message?.kind !== "emit-order") return;
    try { await hub.emitDriverOrderUpdate(message.userId, message.payload); process.send?.({ kind: "done", request: message.request }); }
    catch { process.send?.({ kind: "failed", request: message.request }); }
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  process.send?.({ kind: "ready", port: (http.address() as any).port });
}
main().catch(() => { process.send?.({ kind: "startup-failed" }); process.exitCode = 1; });
