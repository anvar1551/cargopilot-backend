"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startSupportRetentionWorker = startSupportRetentionWorker;
const supportService_1 = require("./supportService");
let started = false;
function startSupportRetentionWorker() {
    if (started)
        return;
    started = true;
    const retentionDays = Math.max(1, Number(process.env.SUPPORT_RESOLVED_RETENTION_DAYS || 30));
    const intervalMs = Math.max(60 * 60 * 1000, Number(process.env.SUPPORT_RETENTION_INTERVAL_MS || 6 * 60 * 60 * 1000));
    const run = async () => {
        try {
            const archived = await (0, supportService_1.archiveResolvedSupportTickets)(retentionDays);
            if (archived > 0) {
                console.log(`[support-retention] archived=${archived}`);
            }
        }
        catch (err) {
            console.error(`[support-retention] failed: ${err?.message || "unknown"}`);
        }
    };
    const timer = setInterval(() => {
        void run();
    }, intervalMs);
    timer.unref();
    void run();
}
