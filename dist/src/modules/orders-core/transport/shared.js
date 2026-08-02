"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseMaxPhotoBytes = parseMaxPhotoBytes;
exports.fieldValue = fieldValue;
exports.asEnumValue = asEnumValue;
exports.parseNumber = parseNumber;
exports.emitMutationInvalidation = emitMutationInvalidation;
exports.sendError = sendError;
exports.ensureOrderInScope = ensureOrderInScope;
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const analyticsInvalidate_1 = require("../../../middleware/analyticsInvalidate");
const identity_access_1 = require("../../identity-access");
function parseMaxPhotoBytes() {
    const fallback = 6 * 1024 * 1024;
    const raw = Number(process.env.DELIVERY_PROOF_MAX_PHOTO_BYTES ?? fallback);
    if (!Number.isFinite(raw) || raw <= 0)
        return fallback;
    return Math.floor(raw);
}
function fieldValue(field) {
    if (field == null)
        return undefined;
    if (typeof field === "string")
        return field;
    if (typeof field.value === "string")
        return field.value;
    return undefined;
}
function asEnumValue(value, allowed, fieldName) {
    if (value == null || value === "")
        return undefined;
    const asText = String(value).trim();
    if (allowed.includes(asText)) {
        return asText;
    }
    const err = new Error(`Invalid ${fieldName}: ${asText}`);
    err.statusCode = 400;
    throw err;
}
function parseNumber(value, fieldName, required = false) {
    if (value == null || value === "") {
        if (required) {
            const err = new Error(`${fieldName} is required`);
            err.statusCode = 400;
            throw err;
        }
        return undefined;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        const err = new Error(`${fieldName} must be a number`);
        err.statusCode = 400;
        throw err;
    }
    return parsed;
}
async function emitMutationInvalidation(reason) {
    try {
        await (0, analyticsInvalidate_1.emitAnalyticsInvalidationForMutation)({ reason });
    }
    catch (err) {
        console.warn("[orders] analytics invalidation skipped", {
            reason,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
function sendError(reply, err, fallback = "Failed") {
    const statusCode = err?.statusCode ?? 500;
    if (statusCode >= 500) {
        console.error("[orders] request failed", {
            fallback,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
        });
    }
    return reply.code(statusCode).send({ error: err?.message ?? fallback });
}
async function ensureOrderInScope(request, orderId) {
    const user = request.user;
    if (!user) {
        const err = new Error("Unauthorized");
        err.statusCode = 401;
        throw err;
    }
    await (0, identity_access_1.authorize)(user, "shipment.view");
    const scopeWhere = (await (0, identity_access_1.buildOrderScopeWhere)(user)) ?? { id: "__no_access__" };
    const order = await prismaClient_1.default.order.findFirst({
        where: { AND: [{ id: orderId }, scopeWhere] },
        select: { id: true },
    });
    if (!order) {
        const err = new Error("Order not found");
        err.statusCode = 404;
        throw err;
    }
}
