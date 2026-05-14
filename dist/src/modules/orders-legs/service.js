"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listOrderLegs = listOrderLegs;
exports.upsertOrderLeg = upsertOrderLeg;
exports.listPricingComponents = listPricingComponents;
exports.createPricingComponent = createPricingComponent;
exports.listOrderDocuments = listOrderDocuments;
const client_1 = require("@prisma/client");
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const analyticsOutbox_1 = require("../../features/manager/analyticsOutbox");
const orderService_shared_1 = require("../../services/orders/orderService.shared");
function toDate(value) {
    if (!value)
        return null;
    if (value instanceof Date)
        return value;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        throw (0, orderService_shared_1.orderError)(`Invalid date: ${value}`, 400);
    }
    return parsed;
}
function resolveActorTenantScope(actor) {
    if (actor?.role === "warehouse" && actor.warehouseId) {
        return `warehouse:${actor.warehouseId}`;
    }
    if (actor?.role) {
        return `role:${actor.role}`;
    }
    return "global";
}
async function ensureOrderExists(orderId) {
    const exists = await prismaClient_1.default.order.findUnique({
        where: { id: orderId },
        select: { id: true },
    });
    if (!exists) {
        throw (0, orderService_shared_1.orderError)("Order not found", 404);
    }
}
async function listOrderLegs(orderId) {
    await ensureOrderExists(orderId);
    return prismaClient_1.default.orderLeg.findMany({
        where: { orderId },
        orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
    });
}
async function upsertOrderLeg(orderId, input, actor) {
    await ensureOrderExists(orderId);
    if (!input.legId && (input.sequence == null || input.sequence <= 0)) {
        throw (0, orderService_shared_1.orderError)("sequence is required for new leg and must be > 0", 400);
    }
    return prismaClient_1.default.$transaction(async (tx) => {
        let leg;
        if (input.legId) {
            const existing = await tx.orderLeg.findFirst({
                where: { id: input.legId, orderId },
                select: { id: true },
            });
            if (!existing) {
                throw (0, orderService_shared_1.orderError)("Order leg not found for this order", 404);
            }
            leg = await tx.orderLeg.update({
                where: { id: existing.id },
                data: {
                    sequence: input.sequence ?? undefined,
                    mode: input.mode ?? undefined,
                    status: input.status ?? undefined,
                    fromCountry: input.fromCountry ?? undefined,
                    toCountry: input.toCountry ?? undefined,
                    transitRoute: input.transitRoute === undefined
                        ? undefined
                        : input.transitRoute,
                    fromWarehouseId: input.fromWarehouseId ?? undefined,
                    toWarehouseId: input.toWarehouseId ?? undefined,
                    carrierCode: input.carrierCode ?? undefined,
                    carrierRef: input.carrierRef ?? undefined,
                    vehicleRef: input.vehicleRef ?? undefined,
                    plannedDepartureAt: toDate(input.plannedDepartureAt) ?? undefined,
                    plannedArrivalAt: toDate(input.plannedArrivalAt) ?? undefined,
                    actualDepartureAt: toDate(input.actualDepartureAt) ?? undefined,
                    actualArrivalAt: toDate(input.actualArrivalAt) ?? undefined,
                    notes: input.notes ?? undefined,
                    metadata: input.metadata === undefined
                        ? undefined
                        : input.metadata,
                },
            });
        }
        else {
            leg = await tx.orderLeg.create({
                data: {
                    orderId,
                    sequence: input.sequence,
                    mode: input.mode ?? client_1.TransportMode.road,
                    status: input.status ?? client_1.OrderLegStatus.planned,
                    fromCountry: input.fromCountry ?? null,
                    toCountry: input.toCountry ?? null,
                    transitRoute: input.transitRoute ?? undefined,
                    fromWarehouseId: input.fromWarehouseId ?? null,
                    toWarehouseId: input.toWarehouseId ?? null,
                    carrierCode: input.carrierCode ?? null,
                    carrierRef: input.carrierRef ?? null,
                    vehicleRef: input.vehicleRef ?? null,
                    plannedDepartureAt: toDate(input.plannedDepartureAt),
                    plannedArrivalAt: toDate(input.plannedArrivalAt),
                    actualDepartureAt: toDate(input.actualDepartureAt),
                    actualArrivalAt: toDate(input.actualArrivalAt),
                    notes: input.notes ?? null,
                    metadata: input.metadata ?? undefined,
                },
            });
        }
        await (0, analyticsOutbox_1.enqueueCargoPilotDomainEventsTx)(tx, [
            {
                type: "order_status_changed",
                tenantScope: resolveActorTenantScope(actor),
                entityId: orderId,
                payload: {
                    source: "order_leg_upsert",
                    legId: leg.id,
                    mode: leg.mode,
                    status: leg.status,
                    actorId: actor?.id ?? null,
                    actorRole: actor?.role ?? null,
                },
            },
        ]);
        return leg;
    });
}
async function listPricingComponents(orderId) {
    await ensureOrderExists(orderId);
    return prismaClient_1.default.pricingComponent.findMany({
        where: { orderId },
        orderBy: [{ createdAt: "desc" }],
    });
}
async function createPricingComponent(orderId, input, actor) {
    await ensureOrderExists(orderId);
    if (!Number.isFinite(input.amount)) {
        throw (0, orderService_shared_1.orderError)("amount must be a finite number", 400);
    }
    if (!input.currency || !input.currency.trim()) {
        throw (0, orderService_shared_1.orderError)("currency is required", 400);
    }
    return prismaClient_1.default.$transaction(async (tx) => {
        if (input.orderLegId) {
            const leg = await tx.orderLeg.findFirst({
                where: { id: input.orderLegId, orderId },
                select: { id: true },
            });
            if (!leg) {
                throw (0, orderService_shared_1.orderError)("orderLegId is invalid for this order", 400);
            }
        }
        const created = await tx.pricingComponent.create({
            data: {
                orderId,
                orderLegId: input.orderLegId ?? null,
                componentType: input.componentType,
                source: input.source ?? client_1.PricingComponentSource.manual,
                description: input.description ?? null,
                amount: input.amount,
                currency: input.currency.trim().toUpperCase(),
                fxRateSnapshot: input.fxRateSnapshot ?? null,
                baseCurrency: input.baseCurrency?.trim().toUpperCase() ?? null,
                baseAmount: input.baseAmount ?? null,
                referenceKey: input.referenceKey ?? null,
            },
        });
        await (0, analyticsOutbox_1.enqueueCargoPilotDomainEventsTx)(tx, [
            {
                type: "order_status_changed",
                tenantScope: resolveActorTenantScope(actor),
                entityId: orderId,
                payload: {
                    source: "pricing_component_create",
                    pricingComponentId: created.id,
                    componentType: created.componentType,
                    currency: created.currency,
                    amount: String(created.amount),
                    actorId: actor?.id ?? null,
                    actorRole: actor?.role ?? null,
                },
            },
        ]);
        return created;
    });
}
async function listOrderDocuments(orderId, args) {
    await ensureOrderExists(orderId);
    const limit = Math.min(Math.max(args?.limit ?? 100, 1), 500);
    return prismaClient_1.default.orderDocument.findMany({
        where: {
            orderId,
            ...(args?.type ? { type: args.type } : {}),
        },
        orderBy: [{ createdAt: "desc" }],
        take: limit,
    });
}
