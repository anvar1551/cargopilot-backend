"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
describe("opsMetrics SSE tracking", () => {
    const originalEnv = { ...process.env };
    afterEach(() => {
        process.env = { ...originalEnv };
        jest.resetModules();
    });
    it("tracks reconnect spikes and active/disconnect counts", async () => {
        process.env.OPS_SSE_RECONNECT_WINDOW_MS = "2000";
        const ops = await Promise.resolve().then(() => __importStar(require("../../src/modules/observability-core/application/opsMetrics")));
        ops.recordSseConnected({ stream: "analytics", clientKey: "u1:ip" });
        ops.recordSseConnected({ stream: "analytics", clientKey: "u1:ip" });
        ops.recordSseDisconnected("analytics");
        const snapshot = ops.getOpsMetricsSnapshot();
        expect(snapshot.sse.analytics.totalConnects).toBeGreaterThanOrEqual(2);
        expect(snapshot.sse.analytics.totalDisconnects).toBeGreaterThanOrEqual(1);
        expect(snapshot.sse.analytics.reconnectSpikes).toBeGreaterThanOrEqual(1);
        expect(snapshot.sse.analytics.active).toBeGreaterThanOrEqual(1);
    });
});
