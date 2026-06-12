"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.emitAnalyticsInvalidationForMutation = emitAnalyticsInvalidationForMutation;
const analyticsEvents_1 = require("../modules/analytics-core/realtime/analyticsEvents");
async function emitAnalyticsInvalidationForMutation(args) {
    await (0, analyticsEvents_1.publishCargoPilotDomainEvent)({
        type: "manual_refresh",
        tenantScope: "global",
        entityId: null,
        payload: { reason: args.reason },
    });
}
