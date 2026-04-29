"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyticsInvalidateOnSuccess = analyticsInvalidateOnSuccess;
const analyticsV2Realtime_1 = require("../features/manager/analyticsV2Realtime");
function isMutatingMethod(method) {
    return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
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
            void (0, analyticsV2Realtime_1.publishAnalyticsInvalidation)(resolved);
        });
        return next();
    };
}
