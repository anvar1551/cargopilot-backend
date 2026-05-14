"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.list = list;
exports.getOne = getOne;
exports.listDriverWorkload = listDriverWorkload;
exports.exportCsv = exportCsv;
const __1 = require("..");
/** Lists orders with pagination and RBAC-aware visibility rules. */
async function list(req, res) {
    try {
        const actor = req.user;
        const result = await (0, __1.listOrdersForActor)({ actor, query: req.query });
        res.json(result);
    }
    catch (err) {
        res.status(err?.statusCode ?? 500).json({ error: err.message });
    }
}
/** Returns one order when requester has access to it. */
async function getOne(req, res) {
    try {
        const actor = req.user;
        const result = await (0, __1.getOrderForActor)({ actor, orderId: req.params.id });
        if (result.status === 200)
            return res.json(result.order);
        if (result.status === 404)
            return res.status(404).json({ error: "Not found" });
        return res.status(403).json({ error: "Forbidden" });
    }
    catch (err) {
        console.error("Error in getOne:", err);
        res.status(err?.statusCode ?? 500).json({ error: err.message || "Failed to fetch order" });
    }
}
/** Returns aggregate workload counts grouped by assigned driver. */
async function listDriverWorkload(req, res) {
    try {
        const actor = req.user;
        const workloads = await (0, __1.listDriverWorkloadForActor)(actor);
        return res.json({ workloads });
    }
    catch (err) {
        return res.status(err?.statusCode ?? 500).json({ error: err.message ?? "Failed to fetch workloads" });
    }
}
/** Exports manager-visible orders into a finance-friendly CSV using current filters. */
async function exportCsv(req, res) {
    try {
        const actor = req.user;
        const result = await (0, __1.exportOrdersCsvForActor)({ actor, query: req.query });
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename=\"${result.filename}\"`);
        return res.status(200).send(result.csv);
    }
    catch (err) {
        return res.status(err?.statusCode ?? 500).json({ error: err.message ?? "Failed to export CSV" });
    }
}
