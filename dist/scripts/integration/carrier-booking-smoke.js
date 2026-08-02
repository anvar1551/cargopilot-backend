"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const prismaClient_1 = __importDefault(require("../../src/config/prismaClient"));
const integration_outbox_publisher_1 = require("../../src/modules/integrations-core/infrastructure/integration-outbox.publisher");
const helpers_1 = require("./helpers");
function required(name) {
    return (0, helpers_1.getRequiredEnv)(name);
}
function optionalEnv(name) {
    const value = String(process.env[name] || "").trim();
    return value || null;
}
async function assertFakeCarrierReady(baseUrl) {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/health`);
    if (!response.ok) {
        throw new Error(`fake carrier health failed: ${response.status}`);
    }
}
function getLoginCompanyId(admin) {
    const companyId = typeof admin.user?.companyId === "string" ? admin.user.companyId.trim() : "";
    return companyId || null;
}
async function resolveSmokeOrderLeg(args) {
    if (args.orderId || args.legId) {
        const leg = await prismaClient_1.default.orderLeg.findFirst({
            where: {
                ...(args.legId ? { id: args.legId } : {}),
                ...(args.orderId ? { orderId: args.orderId } : {}),
            },
            orderBy: { sequence: "asc" },
            select: {
                id: true,
                orderId: true,
                sequence: true,
                carrierBookingStatus: true,
                order: { select: { orderNumber: true } },
            },
        });
        if (!leg) {
            throw new Error(`CARRIER_SMOKE_ORDER_ID/CARRIER_SMOKE_LEG_ID do not match an existing leg`);
        }
        return leg;
    }
    const order = await prismaClient_1.default.order.findFirst({
        where: {
            OR: [{ ownerOrgId: args.companyId }, { assignedOrgId: args.companyId }],
            senderName: { not: null },
            senderPhone: { not: null },
            receiverName: { not: null },
            receiverPhone: { not: null },
            pickupAddress: { not: "" },
            dropoffAddress: { not: "" },
            legs: { some: {} },
        },
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            orderNumber: true,
            legs: {
                orderBy: { sequence: "asc" },
                take: 1,
                select: {
                    id: true,
                    orderId: true,
                    sequence: true,
                    carrierBookingStatus: true,
                    order: { select: { orderNumber: true } },
                },
            },
        },
    });
    const leg = order?.legs[0];
    if (!leg) {
        throw new Error("Could not auto-detect an order leg. Set CARRIER_SMOKE_COMPANY_ID, CARRIER_SMOKE_ORDER_ID, and CARRIER_SMOKE_LEG_ID explicitly.");
    }
    return leg;
}
function parseSimulationResult(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return { body: text };
    }
}
async function main() {
    const adminEmail = required("INTEGRATION_ADMIN_EMAIL");
    const adminPassword = required("INTEGRATION_ADMIN_PASSWORD");
    const fakeCarrierBaseUrl = String(process.env.FAKE_CARRIER_BASE_URL || "http://localhost:4100").replace(/\/$/, "");
    const webhookSecret = String(process.env.FAKE_CARRIER_WEBHOOK_SECRET || "dev_fake_carrier_secret").trim();
    const providerCode = optionalEnv("FAKE_CARRIER_PROVIDER_CODE") || `fake_carrier_smoke_${Date.now()}`;
    (0, helpers_1.logStep)("Fake carrier health");
    await assertFakeCarrierReady(fakeCarrierBaseUrl);
    console.log((0, helpers_1.pretty)({ fakeCarrierBaseUrl, providerCode }));
    (0, helpers_1.logStep)("Admin login");
    const admin = await (0, helpers_1.login)(adminEmail, adminPassword);
    const companyId = optionalEnv("CARRIER_SMOKE_COMPANY_ID") || getLoginCompanyId(admin);
    if (!companyId) {
        throw new Error("Could not resolve companyId from login response. Set CARRIER_SMOKE_COMPANY_ID.");
    }
    (0, helpers_1.logStep)("Resolve smoke order leg");
    const smokeLeg = await resolveSmokeOrderLeg({
        companyId,
        orderId: optionalEnv("CARRIER_SMOKE_ORDER_ID"),
        legId: optionalEnv("CARRIER_SMOKE_LEG_ID"),
    });
    const orderId = smokeLeg.orderId;
    const legId = smokeLeg.id;
    console.log((0, helpers_1.pretty)({
        companyId,
        orderId,
        orderNumber: smokeLeg.order.orderNumber,
        legId,
        legSequence: smokeLeg.sequence,
        previousCarrierBookingStatus: smokeLeg.carrierBookingStatus,
    }));
    (0, helpers_1.logStep)("Upsert active fake carrier provider");
    const provider = await (0, helpers_1.httpJson)({
        method: "POST",
        path: "/api/integrations/providers",
        token: admin.token,
        body: {
            companyId,
            domain: "carrier",
            providerCode,
            environment: "sandbox",
            status: "active",
            capabilities: ["create_shipment", "track", "cancel", "webhook"],
            timeoutMs: 5000,
        },
    });
    console.log((0, helpers_1.pretty)(provider));
    (0, helpers_1.logStep)("Rotate provider secret");
    await (0, helpers_1.httpJson)({
        method: "POST",
        path: `/api/integrations/providers/${provider.id}/rotate-secret`,
        token: admin.token,
        body: {
            secretPayload: {
                baseUrl: fakeCarrierBaseUrl,
                webhookSecret,
                webhookSignatureHeader: "x-signature",
                webhookTimestampHeader: "x-signature-timestamp",
                webhookMaxSkewSeconds: 300,
            },
        },
    });
    (0, helpers_1.logStep)("Request carrier booking for leg");
    const booking = await (0, helpers_1.httpJson)({
        method: "POST",
        path: `/api/orders/${orderId}/legs/${legId}/carrier-booking`,
        token: admin.token,
        body: { providerId: provider.id },
    });
    console.log((0, helpers_1.pretty)(booking));
    (0, helpers_1.logStep)("Process outbox once");
    const outboxResult = await (0, integration_outbox_publisher_1.processIntegrationOutboxBatchOnce)();
    console.log((0, helpers_1.pretty)(outboxResult));
    const bookedLeg = await prismaClient_1.default.orderLeg.findUnique({
        where: { id: legId },
        select: {
            id: true,
            status: true,
            carrierBookingStatus: true,
            carrierRef: true,
            carrierTrackingNumber: true,
        },
    });
    if (!bookedLeg || bookedLeg.carrierBookingStatus !== "booked" || !bookedLeg.carrierRef) {
        throw new Error(`leg was not booked: ${JSON.stringify(bookedLeg)}`);
    }
    console.log((0, helpers_1.pretty)(bookedLeg));
    (0, helpers_1.logStep)("Send signed carrier status webhook");
    const webhookTarget = `${(0, helpers_1.getBaseUrl)()}/api/integrations/webhooks/${provider.id}`;
    const runId = `smoke-${Date.now()}`;
    const webhookPayload = {
        eventId: `fake-status-${legId}-${runId}`,
        eventType: "carrier.status.updated",
        occurredAt: new Date().toISOString(),
        aggregateType: "shipment",
        aggregateId: legId,
        partnerShipmentId: bookedLeg.carrierRef,
        trackingNumber: bookedLeg.carrierTrackingNumber,
        statusCode: "in_transit",
        statusLabel: `In transit ${runId}`,
        location: "Fake Carrier Hub",
    };
    const trackingCountBefore = await prismaClient_1.default.tracking.count({
        where: {
            orderLegId: legId,
            note: { contains: runId },
        },
    });
    const webhookResult = await fetch(`${fakeCarrierBaseUrl}/webhooks/simulate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            targetUrl: webhookTarget,
            secret: webhookSecret,
            payload: webhookPayload,
        }),
    });
    const webhookText = await webhookResult.text();
    if (!webhookResult.ok) {
        throw new Error(`fake webhook simulation failed: ${webhookResult.status} ${webhookText}`);
    }
    const firstWebhookResult = parseSimulationResult(webhookText);
    if (firstWebhookResult.status !== 202) {
        throw new Error(`CargoPilot webhook was not accepted: ${webhookText}`);
    }
    console.log(webhookText);
    (0, helpers_1.logStep)("Send duplicate signed carrier status webhook");
    const duplicateWebhookResult = await fetch(`${fakeCarrierBaseUrl}/webhooks/simulate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            targetUrl: webhookTarget,
            secret: webhookSecret,
            payload: webhookPayload,
        }),
    });
    const duplicateWebhookText = await duplicateWebhookResult.text();
    if (!duplicateWebhookResult.ok) {
        throw new Error(`fake duplicate webhook simulation failed: ${duplicateWebhookResult.status} ${duplicateWebhookText}`);
    }
    const secondWebhookResult = parseSimulationResult(duplicateWebhookText);
    if (secondWebhookResult.status !== 200 || !String(secondWebhookResult.body || "").includes("duplicate")) {
        throw new Error(`CargoPilot duplicate webhook was not idempotent: ${duplicateWebhookText}`);
    }
    console.log(duplicateWebhookText);
    (0, helpers_1.logStep)("Process canonical webhook event once");
    await (0, helpers_1.sleep)(250);
    const webhookProcessResult = await (0, integration_outbox_publisher_1.processIntegrationOutboxBatchOnce)();
    console.log((0, helpers_1.pretty)(webhookProcessResult));
    const updatedLeg = await prismaClient_1.default.orderLeg.findUnique({
        where: { id: legId },
        select: {
            id: true,
            status: true,
            carrierBookingStatus: true,
            carrierRef: true,
            carrierTrackingNumber: true,
            carrierLastStatusAt: true,
            trackingEvents: {
                orderBy: { timestamp: "desc" },
                take: 3,
                select: { note: true, timestamp: true },
            },
        },
    });
    if (!updatedLeg || updatedLeg.status !== "in_transit") {
        throw new Error(`leg was not updated by webhook: ${JSON.stringify(updatedLeg)}`);
    }
    const trackingCountAfter = await prismaClient_1.default.tracking.count({
        where: {
            orderLegId: legId,
            note: { contains: runId },
        },
    });
    if (trackingCountAfter - trackingCountBefore !== 1) {
        throw new Error(`duplicate webhook created duplicate tracking events: before=${trackingCountBefore} after=${trackingCountAfter}`);
    }
    (0, helpers_1.logStep)("Carrier integration smoke passed");
    console.log((0, helpers_1.pretty)(updatedLeg));
}
void main()
    .catch((error) => {
    console.error("[integration] carrier booking smoke failed:", error?.message || error);
    process.exitCode = 1;
})
    .finally(async () => {
    await prismaClient_1.default.$disconnect().catch(() => undefined);
});
