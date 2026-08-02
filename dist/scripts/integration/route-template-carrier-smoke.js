"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const prismaClient_1 = __importDefault(require("../../src/config/prismaClient"));
const integration_outbox_publisher_1 = require("../../src/modules/integrations-core/infrastructure/integration-outbox.publisher");
const helpers_1 = require("./helpers");
const cleanupIds = {
    orderId: null,
    providerId: null,
    providerCode: null,
    routeTemplateId: null,
    carrierRoutingRuleId: null,
    tariffPlanId: null,
    originRegionId: null,
    destinationRegionId: null,
};
function required(name) {
    return (0, helpers_1.getRequiredEnv)(name);
}
function optionalEnv(name) {
    const value = String(process.env[name] || "").trim();
    return value || null;
}
function shouldCleanup() {
    return String(process.env.ROUTE_TEMPLATE_SMOKE_CLEANUP || "true").trim().toLowerCase() !== "false";
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
function parseSimulationResult(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return { body: text };
    }
}
async function cleanup() {
    if (!shouldCleanup())
        return;
    const db = prismaClient_1.default;
    await db.$transaction(async (tx) => {
        if (cleanupIds.providerCode) {
            await tx.integrationCanonicalEvent.deleteMany({
                where: { providerCode: cleanupIds.providerCode },
            });
            await tx.integrationWebhookEvent.deleteMany({
                where: { providerCode: cleanupIds.providerCode },
            });
            await tx.integrationOutbox.deleteMany({
                where: { providerCode: cleanupIds.providerCode },
            });
        }
        if (cleanupIds.orderId) {
            await tx.tracking.deleteMany({ where: { orderId: cleanupIds.orderId } });
            await tx.cashCollectionEvent.deleteMany({
                where: { cashCollection: { orderId: cleanupIds.orderId } },
            });
            await tx.cashCollection.deleteMany({ where: { orderId: cleanupIds.orderId } });
            await tx.orderLabelJob.deleteMany({ where: { orderId: cleanupIds.orderId } });
            await tx.orderAttachment.deleteMany({ where: { orderId: cleanupIds.orderId } });
            await tx.invoice.deleteMany({ where: { orderId: cleanupIds.orderId } });
            await tx.paymentLedgerEntry.deleteMany({ where: { orderId: cleanupIds.orderId } });
            await tx.paymentIntent.deleteMany({ where: { orderId: cleanupIds.orderId } });
            await tx.orderDocument.deleteMany({ where: { orderId: cleanupIds.orderId } });
            await tx.pricingComponent.deleteMany({ where: { orderId: cleanupIds.orderId } });
            await tx.parcel.deleteMany({ where: { orderId: cleanupIds.orderId } });
            await tx.orderLeg.deleteMany({ where: { orderId: cleanupIds.orderId } });
            await tx.order.deleteMany({ where: { id: cleanupIds.orderId } });
        }
        if (cleanupIds.carrierRoutingRuleId) {
            await tx.carrierRoutingRule.deleteMany({
                where: { id: cleanupIds.carrierRoutingRuleId },
            });
        }
        if (cleanupIds.tariffPlanId) {
            await tx.tariffPlan.deleteMany({ where: { id: cleanupIds.tariffPlanId } });
        }
        if (cleanupIds.routeTemplateId) {
            await tx.routeTemplate.deleteMany({ where: { id: cleanupIds.routeTemplateId } });
        }
        if (cleanupIds.providerId) {
            await tx.integrationProvider.deleteMany({ where: { id: cleanupIds.providerId } });
        }
        if (cleanupIds.originRegionId || cleanupIds.destinationRegionId) {
            await tx.zoneMatrixEntry.deleteMany({
                where: {
                    OR: [
                        ...(cleanupIds.originRegionId
                            ? [
                                { originRegionId: cleanupIds.originRegionId },
                                { destinationRegionId: cleanupIds.originRegionId },
                            ]
                            : []),
                        ...(cleanupIds.destinationRegionId
                            ? [
                                { originRegionId: cleanupIds.destinationRegionId },
                                { destinationRegionId: cleanupIds.destinationRegionId },
                            ]
                            : []),
                    ],
                },
            });
        }
        if (cleanupIds.originRegionId) {
            await tx.pricingRegion.deleteMany({ where: { id: cleanupIds.originRegionId } });
        }
        if (cleanupIds.destinationRegionId) {
            await tx.pricingRegion.deleteMany({ where: { id: cleanupIds.destinationRegionId } });
        }
    });
}
async function main() {
    const adminEmail = required("INTEGRATION_ADMIN_EMAIL");
    const adminPassword = required("INTEGRATION_ADMIN_PASSWORD");
    const fakeCarrierBaseUrl = String(process.env.FAKE_CARRIER_BASE_URL || "http://localhost:4100").replace(/\/$/, "");
    const webhookSecret = String(process.env.FAKE_CARRIER_WEBHOOK_SECRET || "dev_fake_carrier_secret").trim();
    const runId = `rt_${Date.now()}`;
    const originCity = `Smoke Shanghai ${runId}`;
    const destinationCity = `Smoke Tashkent ${runId}`;
    const providerCode = `fake_route_template_${runId}`;
    (0, helpers_1.logStep)("Fake carrier health");
    await assertFakeCarrierReady(fakeCarrierBaseUrl);
    console.log((0, helpers_1.pretty)({ fakeCarrierBaseUrl, providerCode }));
    (0, helpers_1.logStep)("Admin login");
    const admin = await (0, helpers_1.login)(adminEmail, adminPassword);
    const companyId = optionalEnv("ROUTE_TEMPLATE_SMOKE_COMPANY_ID") || getLoginCompanyId(admin);
    if (!companyId) {
        throw new Error("Could not resolve companyId from login response. Set ROUTE_TEMPLATE_SMOKE_COMPANY_ID.");
    }
    (0, helpers_1.logStep)("Create pricing regions and zone");
    const originRegion = await (0, helpers_1.httpJson)({
        method: "POST",
        path: "/api/pricing/regions",
        token: admin.token,
        body: {
            code: `CN_${runId}`,
            name: originCity,
            aliases: [originCity],
            sortOrder: 9000,
            isActive: true,
        },
    });
    cleanupIds.originRegionId = originRegion.id;
    const destinationRegion = await (0, helpers_1.httpJson)({
        method: "POST",
        path: "/api/pricing/regions",
        token: admin.token,
        body: {
            code: `UZ_${runId}`,
            name: destinationCity,
            aliases: [destinationCity],
            sortOrder: 9001,
            isActive: true,
        },
    });
    cleanupIds.destinationRegionId = destinationRegion.id;
    await (0, helpers_1.httpJson)({
        method: "POST",
        path: "/api/pricing/zones/bulk",
        token: admin.token,
        body: {
            entries: [
                {
                    originRegionId: originRegion.id,
                    destinationRegionId: destinationRegion.id,
                    zone: 8,
                },
            ],
        },
    });
    console.log((0, helpers_1.pretty)({ originRegion, destinationRegion, zone: 8 }));
    (0, helpers_1.logStep)("Create active fake carrier provider");
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
    cleanupIds.providerId = provider.id;
    cleanupIds.providerCode = provider.providerCode;
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
    (0, helpers_1.logStep)("Create route template");
    const routeTemplate = await (0, helpers_1.httpJson)({
        method: "POST",
        path: "/api/integrations/route-templates",
        token: admin.token,
        body: {
            companyId,
            name: `CN to UZ route ${runId}`,
            code: `CN_UZ_${runId}`,
            isActive: true,
            priority: 9999,
            serviceType: "DOOR_TO_DOOR",
            transportMode: "air",
            originCountryCode: "CN",
            destinationCountryCode: "UZ",
            legs: [
                {
                    sequence: 1,
                    legCode: "cn_pickup",
                    label: "China pickup",
                    mode: "road",
                    originCountryCode: "CN",
                    destinationCountryCode: "CN",
                },
                {
                    sequence: 2,
                    legCode: "cn_uz_air",
                    label: "China to Uzbekistan air linehaul",
                    mode: "air",
                    originCountryCode: "CN",
                    destinationCountryCode: "UZ",
                },
                {
                    sequence: 3,
                    legCode: "uz_last_mile",
                    label: "Uzbekistan last mile",
                    mode: "road",
                    originCountryCode: "UZ",
                    destinationCountryCode: "UZ",
                },
            ],
        },
    });
    cleanupIds.routeTemplateId = routeTemplate.id;
    const linehaulLeg = routeTemplate.legs.find((leg) => leg.legCode === "cn_uz_air");
    if (!linehaulLeg)
        throw new Error("route template linehaul leg missing");
    console.log((0, helpers_1.pretty)(routeTemplate));
    (0, helpers_1.logStep)("Create LEG_TRANSIT tariff linked to route template");
    const tariffPlan = await (0, helpers_1.httpJson)({
        method: "POST",
        path: "/api/pricing/tariff-plans",
        token: admin.token,
        body: {
            name: `CN to UZ Route Template Tariff ${runId}`,
            code: `CN_UZ_RT_${runId}`,
            description: "Route-template smoke tariff",
            status: "active",
            serviceType: "DOOR_TO_DOOR",
            priceType: "bucket",
            pricingStrategy: "LEG_TRANSIT",
            coverageType: "international",
            transportMode: "AIR",
            originCountryCode: "CN",
            destinationCountryCode: "UZ",
            routeTemplateId: routeTemplate.id,
            currency: "USD",
            priority: 999999,
            isDefault: true,
            rates: [],
            transitLegRates: [
                {
                    sequence: 1,
                    legCode: "cn_pickup",
                    label: "China pickup",
                    mode: "ROAD",
                    originCountryCode: "CN",
                    destinationCountryCode: "CN",
                    ratePerKg: 2,
                    minCharge: 3,
                    flatFee: 0,
                },
                {
                    sequence: 2,
                    legCode: "cn_uz_air",
                    label: "China to Uzbekistan air linehaul",
                    mode: "AIR",
                    originCountryCode: "CN",
                    destinationCountryCode: "UZ",
                    ratePerKg: 10,
                    minCharge: 20,
                    flatFee: 0,
                },
                {
                    sequence: 3,
                    legCode: "uz_last_mile",
                    label: "Uzbekistan last mile",
                    mode: "ROAD",
                    originCountryCode: "UZ",
                    destinationCountryCode: "UZ",
                    ratePerKg: 5,
                    minCharge: 10,
                    flatFee: 0,
                },
            ],
        },
    });
    cleanupIds.tariffPlanId = tariffPlan.id;
    if (tariffPlan.routeTemplateId !== routeTemplate.id) {
        throw new Error(`tariff did not keep routeTemplateId: ${JSON.stringify(tariffPlan)}`);
    }
    console.log((0, helpers_1.pretty)(tariffPlan));
    (0, helpers_1.logStep)("Create carrier rule for exact route template leg");
    const carrierRule = await (0, helpers_1.httpJson)({
        method: "POST",
        path: "/api/integrations/carrier-routing-rules",
        token: admin.token,
        body: {
            companyId,
            name: `Carrier for linehaul ${runId}`,
            code: `CARRIER_LINEHAUL_${runId}`,
            providerId: provider.id,
            routeTemplateId: routeTemplate.id,
            routeTemplateLegId: linehaulLeg.id,
            isActive: true,
            priority: 999999,
            autoBook: true,
            serviceType: "DOOR_TO_DOOR",
            transportMode: "air",
            originCountryCode: "CN",
            destinationCountryCode: "UZ",
            legSequence: linehaulLeg.sequence,
        },
    });
    cleanupIds.carrierRoutingRuleId = carrierRule.id;
    if (carrierRule.routeTemplateLegId !== linehaulLeg.id) {
        throw new Error(`carrier rule did not keep routeTemplateLegId: ${JSON.stringify(carrierRule)}`);
    }
    console.log((0, helpers_1.pretty)(carrierRule));
    (0, helpers_1.logStep)("Create order using route-template tariff");
    const referenceId = `RT-SMOKE-${runId}`;
    const createdOrder = await (0, helpers_1.httpJson)({
        method: "POST",
        path: "/api/orders",
        token: admin.token,
        body: {
            sender: {
                name: "Smoke Sender",
                phone: "+8613800000000",
            },
            receiver: {
                name: "Smoke Receiver",
                phone: "+998901234567",
            },
            addresses: {
                pickupAddress: `${originCity}, CN`,
                dropoffAddress: `${destinationCity}, UZ`,
                destinationCity,
                senderAddress: {
                    country: "CN",
                    city: originCity,
                    street: "Smoke Road 1",
                    latitude: 31.2304,
                    longitude: 121.4737,
                },
                receiverAddress: {
                    country: "UZ",
                    city: destinationCity,
                    street: "Smoke Street 2",
                    latitude: 41.2995,
                    longitude: 69.2401,
                },
            },
            shipment: {
                serviceType: "DOOR_TO_DOOR",
                transportMode: "AIR",
                weightKg: 2,
                currency: "USD",
                codEnabled: false,
                pieceTotal: 1,
                parcels: [{ weightKg: 2 }],
            },
            payment: {
                paymentType: "CASH",
                deliveryChargePaidBy: "SENDER",
                serviceChargePaidStatus: "NOT_PAID",
                ifRecipientNotAvailable: "CALL_SENDER",
            },
            reference: {
                referenceId,
            },
        },
    });
    cleanupIds.orderId = createdOrder.order.id;
    console.log((0, helpers_1.pretty)(createdOrder));
    (0, helpers_1.logStep)("Assert generated order legs and carrier booking request");
    const legs = await prismaClient_1.default.orderLeg.findMany({
        where: { orderId: createdOrder.order.id },
        orderBy: { sequence: "asc" },
        select: {
            id: true,
            sequence: true,
            mode: true,
            fromCountry: true,
            toCountry: true,
            routeTemplateId: true,
            routeTemplateLegId: true,
            carrierBookingStatus: true,
            carrierProviderId: true,
            carrierRef: true,
            carrierTrackingNumber: true,
            metadata: true,
        },
    });
    if (legs.length !== 3) {
        throw new Error(`expected 3 route-template legs, got ${legs.length}: ${JSON.stringify(legs)}`);
    }
    for (const leg of legs) {
        if (leg.routeTemplateId !== routeTemplate.id) {
            throw new Error(`leg missing routeTemplateId: ${JSON.stringify(leg)}`);
        }
    }
    const bookedCandidate = legs.find((leg) => leg.routeTemplateLegId === linehaulLeg.id);
    if (!bookedCandidate)
        throw new Error("linehaul order leg was not generated from route template leg");
    if (!["requested", "booked"].includes(bookedCandidate.carrierBookingStatus)) {
        throw new Error(`linehaul leg was not auto-book requested: ${JSON.stringify(bookedCandidate)}`);
    }
    const untouchedLegs = legs.filter((leg) => leg.id !== bookedCandidate.id);
    if (untouchedLegs.some((leg) => leg.carrierBookingStatus !== "not_requested")) {
        throw new Error(`non-matching legs should not be booked: ${JSON.stringify(untouchedLegs)}`);
    }
    console.log((0, helpers_1.pretty)({ legs }));
    (0, helpers_1.logStep)("Process carrier outbox once");
    const outboxResult = await (0, integration_outbox_publisher_1.processIntegrationOutboxBatchOnce)();
    console.log((0, helpers_1.pretty)(outboxResult));
    const bookedLeg = await prismaClient_1.default.orderLeg.findUnique({
        where: { id: bookedCandidate.id },
        select: {
            id: true,
            status: true,
            carrierBookingStatus: true,
            carrierRef: true,
            carrierTrackingNumber: true,
            routeTemplateLegId: true,
        },
    });
    if (!bookedLeg || bookedLeg.carrierBookingStatus !== "booked" || !bookedLeg.carrierRef) {
        throw new Error(`route-template linehaul leg was not booked: ${JSON.stringify(bookedLeg)}`);
    }
    console.log((0, helpers_1.pretty)(bookedLeg));
    (0, helpers_1.logStep)("Send signed carrier status webhook and process canonical event");
    const webhookTarget = `${(0, helpers_1.getBaseUrl)()}/api/integrations/webhooks/${provider.id}`;
    const webhookRunId = `route-template-${runId}`;
    const webhookPayload = {
        eventId: `fake-route-template-status-${bookedLeg.id}-${webhookRunId}`,
        eventType: "carrier.status.updated",
        occurredAt: new Date().toISOString(),
        aggregateType: "shipment",
        aggregateId: bookedLeg.id,
        partnerShipmentId: bookedLeg.carrierRef,
        trackingNumber: bookedLeg.carrierTrackingNumber,
        statusCode: "in_transit",
        statusLabel: `In transit ${webhookRunId}`,
        location: "Route Template Smoke Hub",
    };
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
    const parsedWebhook = parseSimulationResult(webhookText);
    if (parsedWebhook.status !== 202) {
        throw new Error(`CargoPilot webhook was not accepted: ${webhookText}`);
    }
    console.log(webhookText);
    await (0, helpers_1.sleep)(250);
    const webhookProcessResult = await (0, integration_outbox_publisher_1.processIntegrationOutboxBatchOnce)();
    console.log((0, helpers_1.pretty)(webhookProcessResult));
    const updatedLeg = await prismaClient_1.default.orderLeg.findUnique({
        where: { id: bookedLeg.id },
        select: {
            id: true,
            status: true,
            carrierBookingStatus: true,
            carrierRef: true,
            carrierTrackingNumber: true,
            carrierLastStatusAt: true,
            routeTemplateId: true,
            routeTemplateLegId: true,
            trackingEvents: {
                orderBy: { timestamp: "desc" },
                take: 3,
                select: { note: true, timestamp: true },
            },
        },
    });
    if (!updatedLeg || updatedLeg.status !== "in_transit") {
        throw new Error(`route-template leg was not updated by webhook: ${JSON.stringify(updatedLeg)}`);
    }
    (0, helpers_1.logStep)("Route-template carrier smoke passed");
    console.log((0, helpers_1.pretty)(updatedLeg));
}
void main()
    .catch((error) => {
    console.error("[integration] route-template carrier smoke failed:", error?.message || error);
    process.exitCode = 1;
})
    .finally(async () => {
    try {
        await cleanup();
    }
    catch (error) {
        console.error("[integration] route-template carrier cleanup failed:", error?.message || error);
        process.exitCode = 1;
    }
    await prismaClient_1.default.$disconnect().catch(() => undefined);
});
