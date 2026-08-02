"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyCarrierIntegrationEvent = applyCarrierIntegrationEvent;
const client_1 = require("@prisma/client");
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const autoTriage_1 = require("../support-core/application/autoTriage");
const db = prismaClient_1.default;
function toObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    return value;
}
function pickString(source, keys) {
    const object = toObject(source);
    for (const key of keys) {
        const value = object[key];
        if (typeof value === "string" && value.trim())
            return value.trim();
        if (typeof value === "number" || typeof value === "bigint")
            return String(value);
    }
    return null;
}
function parseDate(value) {
    if (typeof value !== "string" || !value.trim())
        return new Date();
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}
function normalizeProviderStatus(value) {
    return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
}
function mapCarrierStatusToLegStatus(providerStatus) {
    const normalized = normalizeProviderStatus(providerStatus);
    if (!normalized)
        return null;
    if (["booked", "created", "accepted", "confirmed", "label_created"].includes(normalized)) {
        return client_1.OrderLegStatus.booked;
    }
    if (["departed", "picked_up", "pickup_completed"].includes(normalized)) {
        return client_1.OrderLegStatus.departed;
    }
    if (["in_transit", "transit", "moving", "out_for_delivery"].includes(normalized)) {
        return client_1.OrderLegStatus.in_transit;
    }
    if (["arrived", "at_hub", "at_warehouse", "arrival"].includes(normalized)) {
        return client_1.OrderLegStatus.arrived;
    }
    if (["delivered", "completed", "delivery_completed"].includes(normalized)) {
        return client_1.OrderLegStatus.completed;
    }
    if (["cancelled", "canceled"].includes(normalized)) {
        return client_1.OrderLegStatus.cancelled;
    }
    if (["failed", "delivery_failed", "exception", "lost", "damaged", "returned"].includes(normalized)) {
        return client_1.OrderLegStatus.exception;
    }
    return null;
}
function mapCarrierStatusToOrderStatus(providerStatus) {
    const normalized = normalizeProviderStatus(providerStatus);
    if (["in_transit", "transit", "moving"].includes(normalized))
        return "in_transit";
    if (normalized === "out_for_delivery")
        return "out_for_delivery";
    if (["delivered", "completed", "delivery_completed"].includes(normalized))
        return "delivered";
    if (["failed", "delivery_failed", "exception", "lost", "damaged"].includes(normalized))
        return "exception";
    if (["cancelled", "canceled"].includes(normalized))
        return "cancelled";
    return null;
}
function findCreateShipmentPayload(event) {
    const payload = toObject(event.payloadJson);
    const response = toObject(payload.responseJson) || toObject(payload.response) || payload;
    const rawResponse = toObject(response.rawResponse);
    const partnerShipmentId = pickString(response, ["partnerShipmentId", "shipmentId", "id", "carrierRef"]) ||
        pickString(rawResponse, ["partnerShipmentId", "shipmentId", "id", "carrierRef"]);
    const trackingNumber = pickString(response, ["trackingNumber", "awb", "trackingNo"]) ||
        pickString(rawResponse, ["trackingNumber", "awb", "trackingNo"]);
    const labelUrl = pickString(response, ["labelUrl", "labelURL"]) ||
        pickString(rawResponse, ["labelUrl", "labelURL"]);
    return {
        partnerShipmentId,
        trackingNumber,
        labelUrl,
        rawResponse,
    };
}
async function findLegForCarrierEvent(tx, event) {
    const payload = toObject(event.payloadJson);
    const directLegId = event.aggregateType === "shipment" && event.aggregateId ? event.aggregateId : null;
    const metadata = toObject(payload.metadata) || toObject(toObject(payload.input).metadata);
    const payloadLegId = pickString(payload, ["orderLegId", "legId"]) ||
        pickString(metadata, ["orderLegId", "legId"]);
    const partnerShipmentId = pickString(payload, [
        "partnerShipmentId",
        "shipmentId",
        "carrierRef",
    ]);
    const trackingNumber = pickString(payload, ["trackingNumber", "awb", "trackingNo"]);
    if (directLegId || payloadLegId) {
        const leg = await tx.orderLeg.findFirst({
            where: {
                id: directLegId || payloadLegId,
                ...(event.providerId ? { carrierProviderId: event.providerId } : {}),
            },
            include: { order: { select: { id: true, status: true } } },
        });
        if (leg)
            return leg;
    }
    if (partnerShipmentId || trackingNumber) {
        return tx.orderLeg.findFirst({
            where: {
                ...(event.providerId ? { carrierProviderId: event.providerId } : {}),
                OR: [
                    ...(partnerShipmentId ? [{ carrierRef: partnerShipmentId }] : []),
                    ...(trackingNumber ? [{ carrierTrackingNumber: trackingNumber }] : []),
                ],
            },
            include: { order: { select: { id: true, status: true } } },
        });
    }
    return null;
}
async function applyCarrierIntegrationEvent(event) {
    if (event.domain !== "carrier") {
        return { applied: false, ignored: true, reason: "not a carrier event" };
    }
    if (event.eventType === "carrier.shipment.created") {
        const data = findCreateShipmentPayload(event);
        if (!event.aggregateId || !data.partnerShipmentId) {
            return {
                applied: false,
                ignored: true,
                reason: "carrier shipment created event is missing leg or partner shipment id",
            };
        }
        await db.$transaction(async (tx) => {
            const leg = await tx.orderLeg.findFirst({
                where: {
                    id: event.aggregateId,
                    ...(event.providerId ? { carrierProviderId: event.providerId } : {}),
                },
                include: { order: { select: { id: true } } },
            });
            if (!leg)
                throw new Error("OrderLeg not found for carrier shipment created event");
            await tx.orderLeg.update({
                where: { id: leg.id },
                data: {
                    status: client_1.OrderLegStatus.booked,
                    carrierBookingStatus: "booked",
                    carrierRef: data.partnerShipmentId,
                    carrierTrackingNumber: data.trackingNumber ?? null,
                    carrierBookingError: null,
                    carrierBookedAt: new Date(),
                    carrierLastStatusAt: new Date(),
                    metadata: {
                        ...toObject(leg.metadata),
                        carrier: {
                            ...toObject(toObject(leg.metadata).carrier),
                            lastCreateShipmentResponse: data.rawResponse ?? null,
                            labelUrl: data.labelUrl ?? null,
                        },
                    },
                },
            });
            await tx.tracking.create({
                data: {
                    orderId: leg.order.id,
                    orderLegId: leg.id,
                    note: `Carrier booking confirmed by ${event.providerCode}${data.trackingNumber ? ` (${data.trackingNumber})` : ""}`,
                    timestamp: parseDate(event.occurredAt),
                },
            });
        });
        return { applied: true };
    }
    if (event.eventType === "carrier.shipment.failed") {
        if (!event.aggregateId) {
            return { applied: false, ignored: true, reason: "carrier failure event is missing leg id" };
        }
        const payload = toObject(event.payloadJson);
        const errorMessage = pickString(payload, ["message", "error", "reason"]) || "Carrier booking failed";
        let ticketInput = null;
        await db.$transaction(async (tx) => {
            const leg = await tx.orderLeg.findFirst({
                where: {
                    id: event.aggregateId,
                    ...(event.providerId ? { carrierProviderId: event.providerId } : {}),
                },
                include: { order: { select: { id: true } } },
            });
            if (!leg)
                throw new Error("OrderLeg not found for carrier failure event");
            ticketInput = {
                orderId: leg.order.id,
                legId: leg.id,
                providerCode: event.providerCode,
                reason: errorMessage,
            };
            await tx.orderLeg.update({
                where: { id: leg.id },
                data: {
                    carrierBookingStatus: "failed",
                    carrierBookingError: errorMessage.slice(0, 1000),
                    carrierLastStatusAt: new Date(),
                },
            });
            await tx.tracking.create({
                data: {
                    orderId: leg.order.id,
                    orderLegId: leg.id,
                    note: `Carrier booking failed by ${event.providerCode}: ${errorMessage.slice(0, 300)}`,
                    timestamp: parseDate(event.occurredAt),
                },
            });
        });
        if (ticketInput) {
            void (0, autoTriage_1.createCarrierFailureSupportTicket)(ticketInput).catch(() => undefined);
        }
        return { applied: true };
    }
    if (event.eventType === "carrier.status.updated") {
        const payload = toObject(event.payloadJson);
        const providerStatus = pickString(payload, ["statusCode", "status", "code", "state"]);
        const statusLabel = pickString(payload, ["statusLabel", "statusText", "label"]) || providerStatus || "status updated";
        const happenedAt = pickString(payload, ["happenedAt", "updatedAt", "timestamp", "occurredAt"]);
        const location = pickString(payload, ["location", "city", "place"]);
        const legStatus = mapCarrierStatusToLegStatus(providerStatus);
        const orderStatus = mapCarrierStatusToOrderStatus(providerStatus);
        const isFinalFailure = legStatus === client_1.OrderLegStatus.exception;
        const isCancelled = legStatus === client_1.OrderLegStatus.cancelled;
        let ticketInput = null;
        await db.$transaction(async (tx) => {
            const leg = await findLegForCarrierEvent(tx, event);
            if (!leg)
                throw new Error("OrderLeg not found for carrier status event");
            if (isFinalFailure) {
                ticketInput = {
                    orderId: leg.order.id,
                    legId: leg.id,
                    providerCode: event.providerCode,
                    status: providerStatus,
                    reason: statusLabel,
                    terminal: true,
                };
            }
            await tx.orderLeg.update({
                where: { id: leg.id },
                data: {
                    ...(legStatus ? { status: legStatus } : {}),
                    ...(isFinalFailure ? { carrierBookingStatus: "failed" } : {}),
                    ...(isCancelled ? { carrierBookingStatus: "cancelled" } : {}),
                    carrierLastStatusAt: parseDate(happenedAt || event.occurredAt),
                    metadata: {
                        ...toObject(leg.metadata),
                        carrier: {
                            ...toObject(toObject(leg.metadata).carrier),
                            lastStatus: providerStatus,
                            lastStatusPayload: payload,
                        },
                    },
                },
            });
            await tx.tracking.create({
                data: {
                    orderId: leg.order.id,
                    orderLegId: leg.id,
                    status: orderStatus,
                    note: `Carrier ${event.providerCode}: ${statusLabel}${location ? ` at ${location}` : ""}`,
                    region: location ?? null,
                    timestamp: parseDate(happenedAt || event.occurredAt),
                },
            });
        });
        if (ticketInput) {
            void (0, autoTriage_1.createCarrierFailureSupportTicket)(ticketInput).catch(() => undefined);
        }
        return { applied: true };
    }
    return {
        applied: false,
        ignored: true,
        reason: `unsupported carrier event '${event.eventType}'`,
    };
}
