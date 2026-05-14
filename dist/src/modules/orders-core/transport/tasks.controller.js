"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assignTasksBulk = assignTasksBulk;
exports.assignDriversBulk = assignDriversBulk;
exports.updateStatusBulk = updateStatusBulk;
exports.updateDriverStatus = updateDriverStatus;
const __1 = require("..");
/** Assigns drivers in bulk with assignment type metadata. */
async function assignTasksBulk(req, res) {
    try {
        const includeFull = req.query?.include === "full";
        if (!req.user?.id || !req.user?.role) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const actor = (0, __1.requireOrderActor)(req.user);
        const result = await (0, __1.assignTasksBulkForActor)({
            actor,
            body: req.body ?? {},
            includeFull,
        });
        return res.json(result);
    }
    catch (err) {
        const code = err.statusCode ?? 400;
        return res.status(code).json({ error: err.message ?? "Failed" });
    }
}
/** Explicit endpoint name for direct driver assignment flow. */
async function assignDriversBulk(req, res) {
    try {
        const includeFull = req.query?.include === "full";
        if (!req.user?.id || !req.user?.role) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const actor = (0, __1.requireOrderActor)(req.user);
        const result = await (0, __1.assignDriversBulkForActor)({
            actor,
            body: req.body ?? {},
            includeFull,
        });
        return res.json(result);
    }
    catch (err) {
        const code = err.statusCode ?? 400;
        return res.status(code).json({ error: err.message ?? "Failed" });
    }
}
/** Applies bulk order status changes with role-based policy. */
async function updateStatusBulk(req, res) {
    try {
        const includeFull = req.query?.include === "full";
        if (!req.user?.id || !req.user?.role) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const actor = (0, __1.requireOrderActor)(req.user);
        const result = await (0, __1.updateStatusBulkForActor)({
            actor,
            body: req.body ?? {},
            includeFull,
        });
        return res.json(result);
    }
    catch (err) {
        const code = err.statusCode ?? 400;
        return res.status(code).json({ error: err.message ?? "Failed" });
    }
}
/** Applies a single status transition initiated by the assigned driver. */
async function updateDriverStatus(req, res) {
    try {
        if (!req.user?.id || !req.user?.role) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const actor = (0, __1.requireOrderActor)(req.user);
        const result = await (0, __1.updateDriverStatusForActor)({
            actor,
            body: req.body ?? {},
        });
        return res.json(result);
    }
    catch (err) {
        const code = err.statusCode ?? 400;
        return res.status(code).json({ error: err.message ?? "Failed" });
    }
}
