"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startNotificationRetentionWorker = startNotificationRetentionWorker;
const notificationService_1 = require("./notificationService");
let started = false;
function retentionIntervalMs() {
    const raw = Number(process.env.DRIVER_NOTIFICATIONS_CLEANUP_INTERVAL_MS ?? 24 * 60 * 60 * 1000);
    if (!Number.isFinite(raw) || raw < 60000)
        return 24 * 60 * 60 * 1000;
    return Math.floor(raw);
}
/** Starts periodic notification retention cleanup (default every 24h). */
function startNotificationRetentionWorker() {
    if (started)
        return;
    started = true;
    const run = async () => {
        try {
            const result = await (0, notificationService_1.cleanupExpiredNotifications)();
            if (result.count > 0) {
                console.log(`[notifications] cleaned ${result.count} expired rows`);
            }
        }
        catch (err) {
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
    }, 15000).unref();
}
