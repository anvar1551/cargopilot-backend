"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getManagerOpsMetricsController = getManagerOpsMetricsController;
const opsMetrics_1 = require("../observability/opsMetrics");
async function getManagerOpsMetricsController(_req, res) {
    try {
        const snapshot = (0, opsMetrics_1.getOpsMetricsSnapshot)();
        return res.json(snapshot);
    }
    catch (err) {
        return res.status(500).json({ error: err?.message || "Failed to load ops metrics" });
    }
}
