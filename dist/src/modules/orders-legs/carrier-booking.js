"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.bookCarrierForOrderLeg = bookCarrierForOrderLeg;
exports.syncCarrierTrackingForOrderLeg = syncCarrierTrackingForOrderLeg;
exports.cancelCarrierForOrderLeg = cancelCarrierForOrderLeg;
const client_1 = require("@prisma/client");
const crypto_1 = require("crypto");
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const shared_1 = require("../orders-core/shared");
const analyticsOutbox_1 = require("../analytics-core/infrastructure/analyticsOutbox");
const shared_2 = require("./shared");
const db = prismaClient_1.default;
function firstString(...values) {
    for (const value of values) {
        if (typeof value === "string" && value.trim())
            return value.trim();
        if (typeof value === "number" || typeof value === "bigint")
            return String(value);
    }
    return null;
}
function toMinor(value) {
    const numberValue = typeof value === "number"
        ? value
        : typeof value === "string" && value.trim()
            ? Number(value)
            : NaN;
    if (!Number.isFinite(numberValue) || numberValue <= 0)
        return undefined;
    return BigInt(Math.round(numberValue * 100)).toString();
}
function normalizeTransportMode(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (["road", "air", "rail", "sea", "multimodal"].includes(normalized))
        return normalized;
    return "road";
}
function addressNode(args) {
    const name = firstString(args.name);
    const phone = firstString(args.phone);
    const address = firstString(args.address);
    if (!name || !phone || !address)
        return null;
    return {
        name,
        phone,
        address,
        ...(typeof args.lat === "number" ? { lat: args.lat } : {}),
        ...(typeof args.lng === "number" ? { lng: args.lng } : {}),
    };
}
function buildParcels(order) {
    const parcelRows = Array.isArray(order.parcels) ? order.parcels : [];
    const fromParcels = parcelRows
        .map((parcel) => {
        const weightKg = Number(parcel.weightKg);
        if (!Number.isFinite(weightKg) || weightKg <= 0)
            return null;
        return {
            weightKg,
            quantity: 1,
            description: firstString(parcel.parcelCode) ?? undefined,
        };
    })
        .filter(Boolean);
    if (fromParcels.length > 0)
        return fromParcels;
    const fallbackWeight = Number(order.weightKg);
    if (Number.isFinite(fallbackWeight) && fallbackWeight > 0) {
        return [{ weightKg: fallbackWeight, quantity: 1, description: order.orderNumber }];
    }
    return [];
}
async function isOrgInsideCompany(tx, orgId, companyId) {
    if (!orgId)
        return true;
    if (orgId === companyId)
        return true;
    let currentId = orgId;
    for (let depth = 0; currentId && depth < 16; depth += 1) {
        const org = await tx.organization.findUnique({
            where: { id: currentId },
            select: { id: true, parentOrgId: true },
        });
        if (!org)
            return false;
        if (org.parentOrgId === companyId)
            return true;
        currentId = org.parentOrgId;
    }
    return false;
}
function buildCarrierCreateShipmentInput(order, leg) {
    const sender = addressNode({
        name: order.senderName ?? order.customer?.name,
        phone: firstString(order.senderPhone, order.senderPhone2, order.senderPhone3),
        address: firstString(order.senderAddress, order.pickupAddress),
        lat: order.pickupLat,
        lng: order.pickupLng,
    });
    const receiver = addressNode({
        name: order.receiverName,
        phone: firstString(order.receiverPhone, order.receiverPhone2, order.receiverPhone3),
        address: firstString(order.receiverAddress, order.dropoffAddress),
        lat: order.dropoffLat,
        lng: order.dropoffLng,
    });
    const parcels = buildParcels(order);
    if (!sender)
        throw (0, shared_1.orderError)("Order is missing sender contact/address for carrier booking", 400);
    if (!receiver)
        throw (0, shared_1.orderError)("Order is missing receiver contact/address for carrier booking", 400);
    if (parcels.length === 0)
        throw (0, shared_1.orderError)("Order is missing parcel weight for carrier booking", 400);
    return {
        externalOrderId: order.orderNumber,
        sender,
        receiver,
        parcels,
        declaredValueMinor: toMinor(order.itemValue),
        currency: firstString(order.currency) ?? "UZS",
        transportMode: normalizeTransportMode(leg.mode ?? client_1.TransportMode.road),
        serviceCode: firstString(order.serviceType),
        metadata: {
            orderId: order.id,
            orderLegId: leg.id,
            orderNumber: order.orderNumber,
            legSequence: leg.sequence,
            fromCountry: leg.fromCountry ?? null,
            toCountry: leg.toCountry ?? null,
        },
    };
}
async function bookCarrierForOrderLeg(input) {
    const companyId = firstString(input.actor.companyId);
    if (!companyId)
        throw (0, shared_1.orderError)("Active company membership is required", 403);
    return db.$transaction(async (tx) => {
        const provider = await tx.integrationProvider.findFirst({
            where: {
                id: input.providerId,
                companyId,
                domain: "carrier",
                status: "active",
            },
            select: {
                id: true,
                companyId: true,
                providerCode: true,
                environment: true,
                timeoutMs: true,
            },
        });
        if (!provider) {
            throw (0, shared_1.orderError)("Active carrier provider not found for this company", 403);
        }
        const leg = await tx.orderLeg.findFirst({
            where: { id: input.legId, orderId: input.orderId },
            include: {
                order: {
                    include: {
                        parcels: true,
                        customer: { select: { id: true, name: true, email: true } },
                    },
                },
            },
        });
        if (!leg)
            throw (0, shared_1.orderError)("Order leg not found for this order", 404);
        const order = leg.order;
        const [ownerAllowed, assignedAllowed] = await Promise.all([
            isOrgInsideCompany(tx, order.ownerOrgId, provider.companyId),
            isOrgInsideCompany(tx, order.assignedOrgId, provider.companyId),
        ]);
        if (!ownerAllowed || !assignedAllowed) {
            throw (0, shared_1.orderError)("Carrier provider is outside this order company scope", 403);
        }
        const shipmentInput = buildCarrierCreateShipmentInput(order, leg);
        const now = new Date();
        const idempotencyKey = `carrier:create-shipment:${leg.id}:${provider.id}`;
        const envelope = {
            eventId: idempotencyKey,
            eventType: "shipment.assigned",
            occurredAt: now.toISOString(),
            companyId: provider.companyId,
            aggregateType: "shipment",
            aggregateId: leg.id,
            schemaVersion: 1,
            source: "orders-core",
            payload: {
                action: "create_shipment",
                input: shipmentInput,
            },
        };
        const updatedLeg = await tx.orderLeg.update({
            where: { id: leg.id },
            data: {
                carrierProviderId: provider.id,
                carrierCode: provider.providerCode,
                carrierBookingStatus: "requested",
                carrierBookingError: null,
            },
        });
        const outbox = await tx.integrationOutbox.upsert({
            where: {
                companyId_providerCode_idempotencyKey: {
                    companyId: provider.companyId,
                    providerCode: provider.providerCode,
                    idempotencyKey,
                },
            },
            create: {
                companyId: provider.companyId,
                providerId: provider.id,
                domain: "carrier",
                providerCode: provider.providerCode,
                environment: provider.environment,
                eventType: "shipment.assigned",
                aggregateType: "shipment",
                aggregateId: leg.id,
                operation: "create_shipment",
                status: "pending",
                maxAttempts: 10,
                attemptCount: 0,
                nextAttemptAt: now,
                lastError: null,
                idempotencyKey,
                payload: envelope,
            },
            update: {
                providerId: provider.id,
                environment: provider.environment,
                aggregateType: "shipment",
                aggregateId: leg.id,
                operation: "create_shipment",
                ...(leg.carrierBookingStatus === "failed"
                    ? {
                        status: "pending",
                        nextAttemptAt: now,
                        lastError: null,
                    }
                    : {}),
            },
        });
        await (0, analyticsOutbox_1.enqueueCargoPilotDomainEventsTx)(tx, [
            {
                type: "order_status_changed",
                tenantScope: (0, shared_2.resolveActorTenantScope)(input.actor),
                entityId: order.id,
                payload: {
                    source: "carrier_booking_requested",
                    orderId: order.id,
                    legId: leg.id,
                    providerId: provider.id,
                    providerCode: provider.providerCode,
                    actorId: input.actor.id,
                    actorRole: null,
                },
            },
        ]);
        return {
            leg: updatedLeg,
            outbox: {
                id: outbox.id,
                status: outbox.status,
                idempotencyKey: outbox.idempotencyKey,
                providerId: outbox.providerId,
                providerCode: outbox.providerCode,
            },
        };
    });
}
async function loadBookedCarrierLegOrThrow(tx, input) {
    const companyId = firstString(input.actor.companyId);
    if (!companyId)
        throw (0, shared_1.orderError)("Active company membership is required", 403);
    const leg = await tx.orderLeg.findFirst({
        where: { id: input.legId, orderId: input.orderId },
        include: {
            order: { select: { id: true, ownerOrgId: true, assignedOrgId: true } },
            carrierProvider: {
                select: {
                    id: true,
                    companyId: true,
                    providerCode: true,
                    environment: true,
                    status: true,
                    domain: true,
                },
            },
        },
    });
    if (!leg)
        throw (0, shared_1.orderError)("Order leg not found for this order", 404);
    if (!leg.carrierProvider) {
        throw (0, shared_1.orderError)("Order leg has no carrier provider", 400);
    }
    if (leg.carrierProvider.companyId !== companyId) {
        throw (0, shared_1.orderError)("Carrier provider is outside this active company scope", 403);
    }
    if (leg.carrierProvider.domain !== "carrier" || leg.carrierProvider.status !== "active") {
        throw (0, shared_1.orderError)("Carrier provider is not active", 400);
    }
    const [ownerAllowed, assignedAllowed] = await Promise.all([
        isOrgInsideCompany(tx, leg.order.ownerOrgId, leg.carrierProvider.companyId),
        isOrgInsideCompany(tx, leg.order.assignedOrgId, leg.carrierProvider.companyId),
    ]);
    if (!ownerAllowed || !assignedAllowed) {
        throw (0, shared_1.orderError)("Carrier provider is outside this order company scope", 403);
    }
    return leg;
}
function buildCarrierCommandEnvelope(args) {
    const now = new Date();
    return {
        eventId: args.idempotencyKey,
        eventType: "carrier.command.requested",
        occurredAt: now.toISOString(),
        companyId: args.companyId,
        aggregateType: "shipment",
        aggregateId: args.leg.id,
        schemaVersion: 1,
        source: "orders-core",
        payload: {
            action: args.action,
            input: {
                ...args.input,
                metadata: {
                    orderId: args.leg.orderId,
                    orderLegId: args.leg.id,
                    legSequence: args.leg.sequence,
                },
            },
        },
    };
}
async function enqueueCarrierLegCommand(input) {
    const provider = input.leg.carrierProvider;
    const now = new Date();
    const envelope = buildCarrierCommandEnvelope({
        action: input.operation,
        idempotencyKey: input.idempotencyKey,
        companyId: provider.companyId,
        leg: input.leg,
        input: input.commandInput,
    });
    const uniqueWhere = {
        companyId_providerCode_idempotencyKey: {
            companyId: provider.companyId,
            providerCode: provider.providerCode,
            idempotencyKey: input.idempotencyKey,
        },
    };
    if (input.requeueExisting === false) {
        const existing = await input.tx.integrationOutbox.findUnique({
            where: uniqueWhere,
            select: {
                id: true,
                status: true,
                idempotencyKey: true,
                providerId: true,
                providerCode: true,
            },
        });
        if (existing)
            return existing;
    }
    const outbox = await input.tx.integrationOutbox.upsert({
        where: uniqueWhere,
        create: {
            companyId: provider.companyId,
            providerId: provider.id,
            domain: "carrier",
            providerCode: provider.providerCode,
            environment: provider.environment,
            eventType: "carrier.command.requested",
            aggregateType: "shipment",
            aggregateId: input.leg.id,
            operation: input.operation,
            status: "pending",
            maxAttempts: 10,
            attemptCount: 0,
            nextAttemptAt: now,
            lastError: null,
            idempotencyKey: input.idempotencyKey,
            payload: envelope,
        },
        update: {
            providerId: provider.id,
            environment: provider.environment,
            aggregateType: "shipment",
            aggregateId: input.leg.id,
            operation: input.operation,
            status: "pending",
            nextAttemptAt: now,
            lastError: null,
            payload: envelope,
        },
    });
    await (0, analyticsOutbox_1.enqueueCargoPilotDomainEventsTx)(input.tx, [
        {
            type: "order_status_changed",
            tenantScope: (0, shared_2.resolveActorTenantScope)(input.actor),
            entityId: input.leg.orderId,
            payload: {
                source: `carrier_${input.operation}`,
                orderId: input.leg.orderId,
                legId: input.leg.id,
                providerId: provider.id,
                providerCode: provider.providerCode,
                actorId: input.actor.id,
                actorRole: null,
            },
        },
    ]);
    return {
        id: outbox.id,
        status: outbox.status,
        idempotencyKey: outbox.idempotencyKey,
        providerId: outbox.providerId,
        providerCode: outbox.providerCode,
    };
}
async function syncCarrierTrackingForOrderLeg(input) {
    return db.$transaction(async (tx) => {
        const leg = await loadBookedCarrierLegOrThrow(tx, input);
        if (!leg.carrierRef && !leg.carrierTrackingNumber) {
            throw (0, shared_1.orderError)("Order leg has no carrier reference or tracking number to sync", 400);
        }
        const outbox = await enqueueCarrierLegCommand({
            tx,
            actor: input.actor,
            leg,
            operation: "track",
            commandInput: {
                partnerShipmentId: leg.carrierRef ?? undefined,
                trackingNumber: leg.carrierTrackingNumber ?? undefined,
            },
            idempotencyKey: `carrier:track:${leg.id}:${leg.carrierProvider.id}:${(0, crypto_1.randomUUID)()}`,
        });
        return { leg, outbox };
    });
}
async function cancelCarrierForOrderLeg(input) {
    return db.$transaction(async (tx) => {
        const leg = await loadBookedCarrierLegOrThrow(tx, input);
        if (!leg.carrierRef) {
            throw (0, shared_1.orderError)("Order leg has no carrier reference to cancel", 400);
        }
        if (leg.carrierBookingStatus === "cancelled" || leg.status === "cancelled") {
            throw (0, shared_1.orderError)("Carrier booking is already cancelled", 400);
        }
        const outbox = await enqueueCarrierLegCommand({
            tx,
            actor: input.actor,
            leg,
            operation: "cancel_shipment",
            commandInput: {
                partnerShipmentId: leg.carrierRef,
                reason: firstString(input.reason) ?? "Cancelled from CargoPilot",
            },
            idempotencyKey: `carrier:cancel-shipment:${leg.id}:${leg.carrierProvider.id}:${leg.carrierRef}`,
            requeueExisting: false,
        });
        await tx.orderLeg.update({
            where: { id: leg.id },
            data: {
                carrierBookingError: null,
                carrierLastStatusAt: new Date(),
            },
        });
        return { leg, outbox };
    });
}
