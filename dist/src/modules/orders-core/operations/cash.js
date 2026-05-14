"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listCashQueueForActorView = listCashQueueForActorView;
exports.getCashQueueSummaryForActorView = getCashQueueSummaryForActorView;
exports.collectCashForActor = collectCashForActor;
exports.handoffCashForActor = handoffCashForActor;
exports.settleCashForActor = settleCashForActor;
exports.collectCashBulkForActor = collectCashBulkForActor;
exports.handoffCashBulkForActor = handoffCashBulkForActor;
exports.settleCashBulkForActor = settleCashBulkForActor;
const client_1 = require("@prisma/client");
const realtimeHub_1 = require("../../../features/realtime/realtimeHub");
const cashCollection_service_1 = require("../../../features/cash/cashCollection.service");
const shared_1 = require("../shared");
function parseKind(value) {
    if (value === client_1.CashCollectionKind.cod)
        return client_1.CashCollectionKind.cod;
    if (value === client_1.CashCollectionKind.service_charge)
        return client_1.CashCollectionKind.service_charge;
    throw new Error("kind must be 'cod' or 'service_charge'");
}
function parseBulkItems(input) {
    if (!Array.isArray(input) || input.length === 0) {
        throw (0, shared_1.orderError)("items must be a non-empty array", 400);
    }
    const normalized = input
        .map((raw) => {
        const item = raw;
        const orderId = typeof item?.orderId === "string" ? item.orderId.trim() : "";
        if (!orderId)
            throw (0, shared_1.orderError)("Each item must contain a valid orderId", 400);
        return { orderId, kind: parseKind(item?.kind) };
    })
        .reduce((acc, item) => {
        if (!acc.some((row) => row.orderId === item.orderId && row.kind === item.kind)) {
            acc.push(item);
        }
        return acc;
    }, []);
    if (normalized.length > shared_1.ORDER_BULK_MAX_IDS) {
        throw (0, shared_1.orderError)(`Too many cash items: ${normalized.length}. Maximum is ${shared_1.ORDER_BULK_MAX_IDS}.`, 400);
    }
    return normalized;
}
function parseCollectBulkItems(input) {
    if (!Array.isArray(input) || input.length === 0) {
        throw (0, shared_1.orderError)("items must be a non-empty array", 400);
    }
    const normalized = input.map((raw) => {
        const item = raw;
        const orderId = typeof item?.orderId === "string" ? item.orderId.trim() : "";
        if (!orderId)
            throw (0, shared_1.orderError)("Each item must contain a valid orderId", 400);
        const amount = item?.amount == null || item?.amount === "" ? null : Number(item.amount);
        if (amount != null && (!Number.isFinite(amount) || amount <= 0)) {
            throw (0, shared_1.orderError)("Collected amount must be a positive number", 400);
        }
        return {
            orderId,
            kind: parseKind(item?.kind),
            amount,
            note: typeof item?.note === "string" ? item.note : null,
        };
    });
    if (normalized.length > shared_1.ORDER_BULK_MAX_IDS) {
        throw (0, shared_1.orderError)(`Too many cash items: ${normalized.length}. Maximum is ${shared_1.ORDER_BULK_MAX_IDS}.`, 400);
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
function buildCashFilters(query) {
    return {
        statuses: parseStatuses(query.statuses),
        kinds: parseKinds(query.kinds),
        from: parseDate(query.from),
        to: parseDate(query.to),
    };
}
async function listCashQueueForActorView(input) {
    const { actor, query } = input;
    const page = Number(query?.page);
    const pageSize = Number(query?.pageSize ?? query?.limit);
    return (0, cashCollection_service_1.listCashQueueForActor)({
        actor,
        filters: {
            ...buildCashFilters(query),
            page: Number.isFinite(page) ? page : undefined,
            pageSize: Number.isFinite(pageSize) ? pageSize : undefined,
        },
    });
}
async function getCashQueueSummaryForActorView(input) {
    return (0, cashCollection_service_1.getCashQueueSummaryForActor)({
        actor: input.actor,
        filters: buildCashFilters(input.query),
    });
}
async function collectCashForActor(input) {
    const { actor, orderId, body } = input;
    const kind = parseKind(body.kind);
    const order = await (0, cashCollection_service_1.collectOrderCash)({
        orderId,
        kind,
        amount: body.amount == null || body.amount === "" ? null : Number(body.amount),
        note: typeof body.note === "string" ? body.note : null,
        actor,
    });
    pushDriverCashRealtime(order, kind, `Cash collected for order ${order?.orderNumber ?? order?.id}`, "Cash custody has been updated.");
    return { success: true, message: "Cash collection updated", order };
}
async function handoffCashForActor(input) {
    const { actor, orderId, body } = input;
    const toHolderType = body.toHolderType === "driver" ||
        body.toHolderType === "warehouse" ||
        body.toHolderType === "pickup_point"
        ? body.toHolderType
        : null;
    if (!toHolderType) {
        throw (0, shared_1.orderError)("toHolderType must be 'driver', 'warehouse', or 'pickup_point'", 400);
    }
    const kind = parseKind(body.kind);
    const order = await (0, cashCollection_service_1.handoffOrderCash)({
        orderId,
        kind,
        toHolderType,
        toDriverId: typeof body.toDriverId === "string" ? body.toDriverId : null,
        toWarehouseId: typeof body.toWarehouseId === "string" ? body.toWarehouseId : null,
        note: typeof body.note === "string" ? body.note : null,
        actor,
    });
    pushDriverCashRealtime(order, kind, `Cash handoff for order ${order?.orderNumber ?? order?.id}`, "Cash holder has been changed.");
    return { success: true, message: "Cash handoff recorded", order };
}
async function settleCashForActor(input) {
    const { actor, orderId, body } = input;
    const kind = parseKind(body.kind);
    const order = await (0, cashCollection_service_1.settleOrderCash)({
        orderId,
        kind,
        note: typeof body.note === "string" ? body.note : null,
        actor,
    });
    pushDriverCashRealtime(order, kind, `Cash settled for order ${order?.orderNumber ?? order?.id}`, "Cash was settled to finance.");
    return { success: true, message: "Cash settled to finance", order };
}
async function collectCashBulkForActor(input) {
    const { actor, body } = input;
    const items = parseCollectBulkItems(body.items);
    const defaultNote = typeof body.note === "string" ? body.note : null;
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
    for (const order of orders) {
        const matched = items.find((item) => item.orderId === order?.id);
        if (!matched)
            continue;
        pushDriverCashRealtime(order, matched.kind, `Cash collected for order ${order?.orderNumber ?? order?.id}`, "Cash custody has been updated.");
    }
    return {
        statusCode: failed.length ? 207 : 200,
        payload: {
            success: failed.length === 0,
            count: orders.length,
            failedCount: failed.length,
            orders,
            failed,
        },
    };
}
async function handoffCashBulkForActor(input) {
    const { actor, body } = input;
    const toHolderType = body.toHolderType === "driver" ||
        body.toHolderType === "warehouse" ||
        body.toHolderType === "pickup_point"
        ? body.toHolderType
        : null;
    if (!toHolderType) {
        throw (0, shared_1.orderError)("toHolderType must be 'driver', 'warehouse', or 'pickup_point'", 400);
    }
    const items = parseBulkItems(body.items);
    const note = typeof body.note === "string" ? body.note : null;
    const toDriverId = typeof body.toDriverId === "string" ? body.toDriverId : null;
    const toWarehouseId = typeof body.toWarehouseId === "string" ? body.toWarehouseId : null;
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
    for (const order of orders) {
        const matched = items.find((item) => item.orderId === order?.id);
        if (!matched)
            continue;
        pushDriverCashRealtime(order, matched.kind, `Cash handoff for order ${order?.orderNumber ?? order?.id}`, "Cash holder has been changed.");
    }
    return {
        statusCode: failed.length ? 207 : 200,
        payload: {
            success: failed.length === 0,
            count: orders.length,
            failedCount: failed.length,
            orders,
            failed,
        },
    };
}
async function settleCashBulkForActor(input) {
    const { actor, body } = input;
    const items = parseBulkItems(body.items);
    const note = typeof body.note === "string" ? body.note : null;
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
    for (const order of orders) {
        const matched = items.find((item) => item.orderId === order?.id);
        if (!matched)
            continue;
        pushDriverCashRealtime(order, matched.kind, `Cash settled for order ${order?.orderNumber ?? order?.id}`, "Cash was settled to finance.");
    }
    return {
        statusCode: failed.length ? 207 : 200,
        payload: {
            success: failed.length === 0,
            count: orders.length,
            failedCount: failed.length,
            orders,
            failed,
        },
    };
}
