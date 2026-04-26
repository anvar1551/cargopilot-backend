import { cleanupExpiredNotifications } from "./notificationService";

let started = false;

function retentionIntervalMs() {
  const raw = Number(process.env.DRIVER_NOTIFICATIONS_CLEANUP_INTERVAL_MS ?? 24 * 60 * 60 * 1000);
  if (!Number.isFinite(raw) || raw < 60_000) return 24 * 60 * 60 * 1000;
  return Math.floor(raw);
}

/** Starts periodic notification retention cleanup (default every 24h). */
export function startNotificationRetentionWorker() {
  if (started) return;
  started = true;

  const run = async () => {
    try {
      const result = await cleanupExpiredNotifications();
      if (result.count > 0) {
        console.log(`[notifications] cleaned ${result.count} expired rows`);
      }
    } catch (err: any) {
      console.error(`[notifications] cleanup failed: ${err?.message ?? "unknown error"}`);
    }
  };

  const timer = setInterval(() => {
    void run();
  }, retentionIntervalMs());
  timer.unref();

  // run shortly after boot
  setTimeout(() => {
    void run();
  }, 15_000).unref();
}

