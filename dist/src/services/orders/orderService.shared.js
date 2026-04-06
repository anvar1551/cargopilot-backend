"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ORDER_BULK_MAX_IDS = void 0;
exports.orderError = orderError;
exports.toOrderActor = toOrderActor;
exports.requireOrderActor = requireOrderActor;
exports.normalizeBulkOrderIds = normalizeBulkOrderIds;
function parsePositiveInt(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return fallback;
    return Math.floor(parsed);
}
/** Max number of order ids accepted by one bulk write operation. */
exports.ORDER_BULK_MAX_IDS = parsePositiveInt(process.env.ORDER_BULK_MAX_IDS, 100);
/**
 * Creates an Error object with HTTP-like status metadata used by order services.
 */
function orderError(message, statusCode = 400) {
    const e = new Error(message);
    e.statusCode = statusCode;
    return e;
}
/**
 * Converts auth middleware user payload into a strict order-service actor.
 */
function toOrderActor(user) {
    if (!user?.id || !user?.role)
        return null;
    return {
        id: user.id,
        role: user.role,
        warehouseId: user.warehouseId ?? null,
    };
}
/**
 * Returns an actor or throws a 401 service error when auth context is missing.
 */
function requireOrderActor(user) {
    const actor = toOrderActor(user);
    if (!actor) {
        throw orderError("Unauthorized", 401);
    }
    return actor;
}
/**
 * Validates and normalizes bulk order id arrays.
 * - rejects empty or non-string input
 * - removes duplicates
 * - enforces hard server-side max size
 */
function normalizeBulkOrderIds(input) {
    if (!Array.isArray(input) || input.length === 0) {
        throw orderError("orderIds must be a non-empty array", 400);
    }
    const normalized = Array.from(new Set(input
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean)));
    if (normalized.length === 0) {
        throw orderError("orderIds must contain valid id strings", 400);
    }
    if (normalized.length > exports.ORDER_BULK_MAX_IDS) {
        throw orderError(`Too many orderIds: ${normalized.length}. Maximum is ${exports.ORDER_BULK_MAX_IDS}.`, 400);
    }
    return normalized;
}
