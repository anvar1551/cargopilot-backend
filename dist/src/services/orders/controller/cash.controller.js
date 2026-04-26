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
const client_1 = require("@prisma/client");
const realtimeHub_1 = require("../../../features/realtime/realtimeHub");
const cashCollection_service_1 = require("../../../features/cash/cashCollection.service");
const orderService_shared_1 = require("../orderService.shared");
function parseKind(value) {
    if (value === client_1.CashCollectionKind.cod)
        return client_1.CashCollectionKind.cod;
    if (value === client_1.CashCollectionKind.service_charge) {
        return client_1.CashCollectionKind.service_charge;
    }
    throw new Error("kind must be 'cod' or 'service_charge'");
}
function parseBulkItems(input) {
    if (!Array.isArray(input) || input.length === 0) {
        throw (0, orderService_shared_1.orderError)("items must be a non-empty array", 400);
    }
    const normalized = input
        .map((raw) => {
        const item = raw;
        const orderId = typeof item?.orderId === "string" ? item.orderId.trim() : "";
        if (!orderId) {
            throw (0, orderService_shared_1.orderError)("Each item must contain a valid orderId", 400);
        }
        return {
            orderId,
            kind: parseKind(item?.kind),
        };
    })
        .reduce((acc, item) => {
        if (!acc.some((row) => row.orderId === item.orderId && row.kind === item.kind)) {
            acc.push(item);
        }
        return acc;
    }, []);
    if (normalized.length > orderService_shared_1.ORDER_BULK_MAX_IDS) {
        throw (0, orderService_shared_1.orderError)(`Too many cash items: ${normalized.length}. Maximum is ${orderService_shared_1.ORDER_BULK_MAX_IDS}.`, 400);
    }
    return normalized;
}
function parseCollectBulkItems(input) {
    if (!Array.isArray(input) || input.length === 0) {
        throw (0, orderService_shared_1.orderError)("items must be a non-empty array", 400);
    }
    const normalized = input.map((raw) => {
        const item = raw;
        const orderId = typeof item?.orderId === "string" ? item.orderId.trim() : "";
        if (!orderId) {
            throw (0, orderService_shared_1.orderError)("Each item must contain a valid orderId", 400);
        }
        const amount = item?.amount == null || item?.amount === ""
            ? null
            : Number(item.amount);
        if (amount != null && (!Number.isFinite(amount) || amount <= 0)) {
            throw (0, orderService_shared_1.orderError)("Collected amount must be a positive number", 400);
        }
        return {
            orderId,
            kind: parseKind(item?.kind),
            amount,
            note: typeof item?.note === "string" ? item.note : null,
        };
    });
    if (normalized.length > orderService_shared_1.ORDER_BULK_MAX_IDS) {
        throw (0, orderService_shared_1.orderError)(`Too many cash items: ${normalized.length}. Maximum is ${orderService_shared_1.ORDER_BULK_MAX_IDS}.`, 400);
    }
    return normalized;
}
function asQueryStringArray(input) {
    if (Array.isArray(input)) {
        return input
            .flatMap((item) => String(item ?? "").split(","))
            .map((value) => value.trim())
            .filter(Boolean);
    }
    if (typeof input === "string") {
        return input
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
    }
    return [];
}
function parseStatuses(input) {
    const values = asQueryStringArray(input);
    const statuses = values.filter((value) => value === client_1.CashCollectionStatus.expected ||
        value === client_1.CashCollectionStatus.held ||
        value === client_1.CashCollectionStatus.settled);
    return Array.from(new Set(statuses));
}
function parseKinds(input) {
    const values = asQueryStringArray(input);
    const kinds = values.filter((value) => value === client_1.CashCollectionKind.cod || value === client_1.CashCollectionKind.service_charge);
    return Array.from(new Set(kinds));
}
function parseDate(input) {
    if (typeof input !== "string" || !input.trim())
        return undefined;
    const parsed = new Date(input);
    if (Number.isNaN(parsed.getTime()))
        return undefined;
    return parsed;
}
function uniqueOrders(orders) {
    const seen = new Set();
    const rows = [];
    for (const order of orders) {
        const key = typeof order?.id === "string" ? order.id : "";
        if (!key || seen.has(key))
            continue;
        seen.add(key);
        rows.push(order);
    }
    return rows;
}
function pushDriverCashRealtime(order, kind, title, body) {
    const assignedDriverId = String(order?.assignedDriverId ?? "").trim();
    if (!assignedDriverId)
        return;
    const orderId = String(order?.id ?? "").trim();
    const orderNumber = String(order?.orderNumber ?? "").trim();
    const status = String(order?.status ?? "").trim();
    const updatedAt = new Date().toISOString();
    (0, realtimeHub_1.emitDriverOrderUpdate)(assignedDriverId, {
        orderId,
        orderNumber: orderNumber || null,
        status,
        updatedAt,
    });
    void (0, realtimeHub_1.emitDriverNotification)(assignedDriverId, {
        type: "cash",
        orderId,
        title,
        body: `${body} (${kind === client_1.CashCollectionKind.cod ? "COD" : "Service charge"})`,
        at: updatedAt,
    }).catch(() => undefined);
}
/** Lists cash queue items scoped for current actor (manager or warehouse). */
async function listCashQueue(req, res) {
    try {
        const actor = (0, orderService_shared_1.requireOrderActor)(req.user);
        const page = Number(req.query?.page);
        const pageSize = Number(req.query?.pageSize ?? req.query?.limit);
        const data = await (0, cashCollection_service_1.listCashQueueForActor)({
            actor,
            filters: {
                page: Number.isFinite(page) ? page : undefined,
                pageSize: Number.isFinite(pageSize) ? pageSize : undefined,
                statuses: parseStatuses(req.query?.statuses),
                kinds: parseKinds(req.query?.kinds),
                from: parseDate(req.query?.from),
                to: parseDate(req.query?.to),
            },
        });
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
        const actor = (0, orderService_shared_1.requireOrderActor)(req.user);
        const summary = await (0, cashCollection_service_1.getCashQueueSummaryForActor)({
            actor,
            filters: {
                statuses: parseStatuses(req.query?.statuses),
                kinds: parseKinds(req.query?.kinds),
                from: parseDate(req.query?.from),
                to: parseDate(req.query?.to),
            },
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
        const actor = (0, orderService_shared_1.requireOrderActor)(req.user);
        const order = await (0, cashCollection_service_1.collectOrderCash)({
            orderId: req.params.id,
            kind: parseKind(req.body?.kind),
            amount: req.body?.amount == null || req.body?.amount === ""
                ? null
                : Number(req.body.amount),
            note: typeof req.body?.note === "string" ? req.body.note : null,
            actor,
        });
        const kind = parseKind(req.body?.kind);
        pushDriverCashRealtime(order, kind, `Cash collected for order ${order?.orderNumber ?? order?.id}`, "Cash custody has been updated.");
        return res.json({
            success: true,
            message: "Cash collection updated",
            order,
        });
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
        const actor = (0, orderService_shared_1.requireOrderActor)(req.user);
        const toHolderType = req.body?.toHolderType === "driver" ||
            req.body?.toHolderType === "warehouse" ||
            req.body?.toHolderType === "pickup_point"
            ? req.body.toHolderType
            : null;
        if (!toHolderType) {
            return res.status(400).json({
                error: "toHolderType must be 'driver', 'warehouse', or 'pickup_point'",
            });
        }
        const order = await (0, cashCollection_service_1.handoffOrderCash)({
            orderId: req.params.id,
            kind: parseKind(req.body?.kind),
            toHolderType,
            toDriverId: typeof req.body?.toDriverId === "string" ? req.body.toDriverId : null,
            toWarehouseId: typeof req.body?.toWarehouseId === "string"
                ? req.body.toWarehouseId
                : null,
            note: typeof req.body?.note === "string" ? req.body.note : null,
            actor,
        });
        const kind = parseKind(req.body?.kind);
        pushDriverCashRealtime(order, kind, `Cash handoff for order ${order?.orderNumber ?? order?.id}`, "Cash holder has been changed.");
        return res.json({
            success: true,
            message: "Cash handoff recorded",
            order,
        });
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
        const actor = (0, orderService_shared_1.requireOrderActor)(req.user);
        const order = await (0, cashCollection_service_1.settleOrderCash)({
            orderId: req.params.id,
            kind: parseKind(req.body?.kind),
            note: typeof req.body?.note === "string" ? req.body.note : null,
            actor,
        });
        const kind = parseKind(req.body?.kind);
        pushDriverCashRealtime(order, kind, `Cash settled for order ${order?.orderNumber ?? order?.id}`, "Cash was settled to finance.");
        return res.json({
            success: true,
            message: "Cash settled to finance",
            order,
        });
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
        const actor = (0, orderService_shared_1.requireOrderActor)(req.user);
        const items = parseCollectBulkItems(req.body?.items);
        const defaultNote = typeof req.body?.note === "string" ? req.body.note : null;
        const updatedOrders = [];
        const failed = [];
        for (const item of items) {
            try {
                const order = await (0, cashCollection_service_1.collectOrderCash)({
                    orderId: item.orderId,
                    kind: item.kind,
                    amount: item.amount ?? null,
                    note: item.note ?? defaultNote,
                    actor,
                });
                if (order)
                    updatedOrders.push(order);
            }
            catch (err) {
                failed.push({
                    orderId: item.orderId,
                    kind: item.kind,
                    error: err?.message ?? "Failed to collect cash",
                });
            }
        }
        const orders = uniqueOrders(updatedOrders);
        const status = failed.length ? 207 : 200;
        for (const order of orders) {
            const matched = items.find((item) => item.orderId === order?.id);
            if (!matched)
                continue;
            pushDriverCashRealtime(order, matched.kind, `Cash collected for order ${order?.orderNumber ?? order?.id}`, "Cash custody has been updated.");
        }
        return res.status(status).json({
            success: failed.length === 0,
            count: orders.length,
            failedCount: failed.length,
            orders,
            failed,
        });
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
        const actor = (0, orderService_shared_1.requireOrderActor)(req.user);
        const toHolderType = req.body?.toHolderType === "driver" ||
            req.body?.toHolderType === "warehouse" ||
            req.body?.toHolderType === "pickup_point"
            ? req.body.toHolderType
            : null;
        if (!toHolderType) {
            return res.status(400).json({
                error: "toHolderType must be 'driver', 'warehouse', or 'pickup_point'",
            });
        }
        const items = parseBulkItems(req.body?.items);
        const note = typeof req.body?.note === "string" ? req.body.note : null;
        const toDriverId = typeof req.body?.toDriverId === "string" ? req.body.toDriverId : null;
        const toWarehouseId = typeof req.body?.toWarehouseId === "string" ? req.body.toWarehouseId : null;
        const updatedOrders = [];
        const failed = [];
        for (const item of items) {
            try {
                const order = await (0, cashCollection_service_1.handoffOrderCash)({
                    orderId: item.orderId,
                    kind: item.kind,
                    toHolderType,
                    toDriverId,
                    toWarehouseId,
                    note,
                    actor,
                });
                if (order)
                    updatedOrders.push(order);
            }
            catch (err) {
                failed.push({
                    orderId: item.orderId,
                    kind: item.kind,
                    error: err?.message ?? "Failed to hand off cash",
                });
            }
        }
        const orders = uniqueOrders(updatedOrders);
        const status = failed.length ? 207 : 200;
        for (const order of orders) {
            const matched = items.find((item) => item.orderId === order?.id);
            if (!matched)
                continue;
            pushDriverCashRealtime(order, matched.kind, `Cash handoff for order ${order?.orderNumber ?? order?.id}`, "Cash holder has been changed.");
        }
        return res.status(status).json({
            success: failed.length === 0,
            count: orders.length,
            failedCount: failed.length,
            orders,
            failed,
        });
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
        const actor = (0, orderService_shared_1.requireOrderActor)(req.user);
        const items = parseBulkItems(req.body?.items);
        const note = typeof req.body?.note === "string" ? req.body.note : null;
        const updatedOrders = [];
        const failed = [];
        for (const item of items) {
            try {
                const order = await (0, cashCollection_service_1.settleOrderCash)({
                    orderId: item.orderId,
                    kind: item.kind,
                    note,
                    actor,
                });
                if (order)
                    updatedOrders.push(order);
            }
            catch (err) {
                failed.push({
                    orderId: item.orderId,
                    kind: item.kind,
                    error: err?.message ?? "Failed to settle cash",
                });
            }
        }
        const orders = uniqueOrders(updatedOrders);
        const status = failed.length ? 207 : 200;
        for (const order of orders) {
            const matched = items.find((item) => item.orderId === order?.id);
            if (!matched)
                continue;
            pushDriverCashRealtime(order, matched.kind, `Cash settled for order ${order?.orderNumber ?? order?.id}`, "Cash was settled to finance.");
        }
        return res.status(status).json({
            success: failed.length === 0,
            count: orders.length,
            failedCount: failed.length,
            orders,
            failed,
        });
    }
    catch (err) {
        return res
            .status(err?.statusCode ?? 400)
            .json({ error: err?.message ?? "Failed to settle cash in bulk" });
    }
}
