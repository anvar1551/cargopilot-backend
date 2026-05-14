"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.emitAnalyticsInvalidationForMutation = emitAnalyticsInvalidationForMutation;
exports.analyticsInvalidateOnSuccess = analyticsInvalidateOnSuccess;
const analyticsEvents_1 = require("../features/manager/analyticsEvents");
const analyticsV2Realtime_1 = require("../features/manager/analyticsV2Realtime");
function isMutatingMethod(method) {
    return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}
function inferEventType(reason, req) {
    const path = req.path.toLowerCase();
    if (reason === "cash_mutation") {
        if (path.includes("/settle"))
            return "cash_settled";
        if (path.includes("/handoff"))
            return "cash_handoff";
        return "order_status_changed";
    }
    if (reason === "order_mutation") {
        if (req.method === "POST" && path === "/")
            return "order_created";
        return "order_status_changed";
    }
    if (reason === "invoice_mutation")
        return "order_status_changed";
    return "manual_refresh";
}
async function emitAnalyticsInvalidationForMutation(args) {
    const directInvalidation = process.env.ANALYTICS_DIRECT_INVALIDATION === "true";
    const legacyEventPublishing = process.env.ANALYTICS_LEGACY_MIDDLEWARE_EVENTS === "true";
    if (!directInvalidation && !legacyEventPublishing)
        return;
    if (directInvalidation) {
        await (0, analyticsV2Realtime_1.publishAnalyticsInvalidation)(args.reason, { source: "api" });
    }
    if (legacyEventPublishing) {
        const role = String(args.user?.role ?? "").trim().toLowerCase();
        const tenantScope = role === "warehouse" && args.user?.warehouseId
            ? `warehouse:${args.user.warehouseId}`
            : role
                ? `role:${role}`
                : "global";
        await (0, analyticsEvents_1.publishCargoPilotDomainEvent)({
            type: inferEventType(args.reason, {
                method: args.method,
                path: args.path,
            }),
            tenantScope,
            entityId: args.entityId?.trim() || null,
            payload: {
                reason: args.reason,
                method: args.method,
                path: args.path,
            },
        });
    }
}
function analyticsInvalidateOnSuccess(reason) {
    return (req, res, next) => {
        if (!isMutatingMethod(req.method)) {
            return next();
        }
        res.on("finish", () => {
            if (res.statusCode < 200 || res.statusCode >= 400)
                return;
            const resolved = typeof reason === "function" ? reason(req) : reason;
            void emitAnalyticsInvalidationForMutation({
                reason: resolved,
                method: req.method,
                path: req.path,
                user: req.user,
                entityId: typeof req.params?.id === "string" && req.params.id.trim()
                    ? req.params.id
                    : null,
            });
        });
        return next();
    };
}
