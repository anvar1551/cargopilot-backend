import { maintainOwnedSupportTickets } from "./supportMaintenance";

let started = false;
let running = false;
let lastErrorLogAt = 0;

function numberFromEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export async function runSupportSlaMonitor(reason = "manual") {
  if (running || process.env.SUPPORT_SLA_MONITOR_ENABLED === "false") return 0;
  running = true;
  try { return await maintainOwnedSupportTickets("sla"); }
  catch { const now=Date.now(); if(now-lastErrorLogAt >= 30000) { lastErrorLogAt=now; console.error("[support-sla] maintenance failed"); } return 0; }
  finally { running = false; }
}

export function startSupportSlaMonitorWorker() {
  if (started || process.env.SUPPORT_SLA_MONITOR_ENABLED === "false") return;
  started = true;

  const intervalMs = Math.max(
    60_000,
    numberFromEnv("SUPPORT_SLA_MONITOR_INTERVAL_MS", 2 * 60_000),
  );
  const timer = setInterval(() => {
    void runSupportSlaMonitor("interval");
  }, intervalMs);
  timer.unref();

  void runSupportSlaMonitor("startup");
}
