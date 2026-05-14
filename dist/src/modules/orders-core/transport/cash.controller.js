"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listCashQueue = listCashQueue;
exports.getCashQueueSummary = getCashQueueSummary;
exports.collectCash = collectCash;
exports.handoffCash = handoffCash;
exports.settleCash = settleCash;
exports.collectCashBulk = collectCashBulk;
exports.handoffCashBulk = handoffCashBulk;
exports.settleCashBulk = settleCashBulk;
const __1 = require("..");
/** Lists cash queue items scoped for current actor (manager or warehouse). */
async function listCashQueue(req, res) {
    try {
        const actor = (0, __1.requireOrderActor)(req.user);
        const data = await (0, __1.listCashQueueForActorView)({ actor, query: req.query ?? {} });
        return res.json(data);
    }
    catch (err) {
        return res
            .status(err?.statusCode ?? 400)
            .json({ error: err?.message ?? "Failed to load cash queue" });
    }
}
/** Returns cash queue totals scoped for current actor (manager or warehouse). */
async function getCashQueueSummary(req, res) {
    try {
        const actor = (0, __1.requireOrderActor)(req.user);
        const summary = await (0, __1.getCashQueueSummaryForActorView)({
            actor,
            query: req.query ?? {},
        });
        return res.json(summary);
    }
    catch (err) {
        return res
            .status(err?.statusCode ?? 400)
            .json({ error: err?.message ?? "Failed to load cash queue summary" });
    }
}
/** Marks a cash item as collected into active custody for an order. */
async function collectCash(req, res) {
    try {
        const actor = (0, __1.requireOrderActor)(req.user);
        const result = await (0, __1.collectCashForActor)({
            actor,
            orderId: req.params.id,
            body: req.body ?? {},
        });
        return res.json(result);
    }
    catch (err) {
        return res
            .status(err?.statusCode ?? 400)
            .json({ error: err?.message ?? "Failed to collect cash" });
    }
}
/** Transfers held cash between operational holders while preserving history. */
async function handoffCash(req, res) {
    try {
        const actor = (0, __1.requireOrderActor)(req.user);
        const result = await (0, __1.handoffCashForActor)({
            actor,
            orderId: req.params.id,
            body: req.body ?? {},
        });
        return res.json(result);
    }
    catch (err) {
        return res
            .status(err?.statusCode ?? 400)
            .json({ error: err?.message ?? "Failed to hand off cash" });
    }
}
/** Settles held cash into finance custody. */
async function settleCash(req, res) {
    try {
        const actor = (0, __1.requireOrderActor)(req.user);
        const result = await (0, __1.settleCashForActor)({
            actor,
            orderId: req.params.id,
            body: req.body ?? {},
        });
        return res.json(result);
    }
    catch (err) {
        return res
            .status(err?.statusCode ?? 400)
            .json({ error: err?.message ?? "Failed to settle cash" });
    }
}
/** Collects multiple cash items into active custody with partial success output. */
async function collectCashBulk(req, res) {
    try {
        const actor = (0, __1.requireOrderActor)(req.user);
        const result = await (0, __1.collectCashBulkForActor)({
            actor,
            body: req.body ?? {},
        });
        return res.status(result.statusCode).json(result.payload);
    }
    catch (err) {
        return res
            .status(err?.statusCode ?? 400)
            .json({ error: err?.message ?? "Failed to collect cash in bulk" });
    }
}
/** Records holder handoff for multiple cash items with partial success output. */
async function handoffCashBulk(req, res) {
    try {
        const actor = (0, __1.requireOrderActor)(req.user);
        const result = await (0, __1.handoffCashBulkForActor)({
            actor,
            body: req.body ?? {},
        });
        return res.status(result.statusCode).json(result.payload);
    }
    catch (err) {
        return res
            .status(err?.statusCode ?? 400)
            .json({ error: err?.message ?? "Failed to hand off cash in bulk" });
    }
}
/** Settles multiple held cash items to finance with partial success output. */
async function settleCashBulk(req, res) {
    try {
        const actor = (0, __1.requireOrderActor)(req.user);
        const result = await (0, __1.settleCashBulkForActor)({
            actor,
            body: req.body ?? {},
        });
        return res.status(result.statusCode).json(result.payload);
    }
    catch (err) {
        return res
            .status(err?.statusCode ?? 400)
            .json({ error: err?.message ?? "Failed to settle cash in bulk" });
    }
}
