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
Object.defineProperty(exports, "__esModule", { value: true });
function outboxRecord() {
    const now = new Date().toISOString();
    return {
        id: "outbox_1",
        companyId: "company_1",
        providerId: "provider_1",
        providerCode: "fake_carrier",
        domain: "carrier",
        environment: "sandbox",
        eventType: "shipment.assigned",
        aggregateType: "shipment",
        aggregateId: "leg_1",
        operation: "create_shipment",
        status: "processing",
        maxAttempts: 10,
        attemptCount: 0,
        nextAttemptAt: now,
        lastAttemptAt: null,
        lastError: null,
        idempotencyKey: "carrier:create-shipment:leg_1:provider_1",
        payload: {
            eventId: "carrier:create-shipment:leg_1:provider_1",
            eventType: "shipment.assigned",
            occurredAt: now,
            companyId: "company_1",
            aggregateType: "shipment",
            aggregateId: "leg_1",
            schemaVersion: 1,
            source: "orders-core",
            payload: { action: "create_shipment" },
        },
        createdAt: now,
        updatedAt: now,
    };
}
function provider(status) {
    const now = new Date().toISOString();
    return {
        providerId: "provider_1",
        companyId: "company_1",
        domain: "carrier",
        providerCode: "fake_carrier",
        status,
        environment: "sandbox",
        capabilities: [],
        rateLimitRps: null,
        timeoutMs: 1000,
        retryPolicyId: null,
        secretRef: null,
        createdAt: now,
        updatedAt: now,
    };
}
describe("integration outbox dispatcher guard", () => {
    beforeAll(() => {
        var _a;
        (_a = process.env).DATABASE_URL || (_a.DATABASE_URL = "postgresql://user:pass@localhost:5432/cargopilot_test");
    });
    it("refuses missing providers", async () => {
        const { resolveIntegrationOutboxDispatcher } = await Promise.resolve().then(() => __importStar(require("../../src/modules/integrations-core/application/outbox-dispatcher")));
        const record = outboxRecord();
        const dispatcher = resolveIntegrationOutboxDispatcher(record, null);
        const result = await dispatcher.dispatch({
            record,
            provider: null,
            timeoutMs: 1000,
        });
        expect(result.sent).toBe(false);
        expect(result.message).toMatch(/provider/i);
    });
    it("refuses inactive providers without provider HTTP calls", async () => {
        const { resolveIntegrationOutboxDispatcher } = await Promise.resolve().then(() => __importStar(require("../../src/modules/integrations-core/application/outbox-dispatcher")));
        const record = outboxRecord();
        const inactive = provider("paused");
        const dispatcher = resolveIntegrationOutboxDispatcher(record, inactive);
        const result = await dispatcher.dispatch({
            record,
            provider: inactive,
            timeoutMs: 1000,
        });
        expect(result.sent).toBe(false);
        expect(result.message).toMatch(/provider/i);
    });
});
