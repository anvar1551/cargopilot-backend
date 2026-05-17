"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listOrderLegs = listOrderLegs;
exports.upsertOrderLeg = upsertOrderLeg;
const client_1 = require("@prisma/client");
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const analyticsOutbox_1 = require("../analytics-core/infrastructure/analyticsOutbox");
const shared_1 = require("../orders-core/shared");
const shared_2 = require("./shared");
async function listOrderLegs(orderId) {
    await (0, shared_2.ensureOrderExists)(orderId);
    return prismaClient_1.default.orderLeg.findMany({
        where: { orderId },
        orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
    });
}
async function upsertOrderLeg(orderId, input, actor) {
    await (0, shared_2.ensureOrderExists)(orderId);
    if (!input.legId && (input.sequence == null || input.sequence <= 0)) {
        throw (0, shared_1.orderError)("sequence is required for new leg and must be > 0", 400);
    }
    return prismaClient_1.default.$transaction(async (tx) => {
        let leg;
        if (input.legId) {
            const existing = await tx.orderLeg.findFirst({
                where: { id: input.legId, orderId },
                select: { id: true },
            });
            if (!existing) {
                throw (0, shared_1.orderError)("Order leg not found for this order", 404);
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
                    plannedDepartureAt: (0, shared_2.toDate)(input.plannedDepartureAt) ?? undefined,
                    plannedArrivalAt: (0, shared_2.toDate)(input.plannedArrivalAt) ?? undefined,
                    actualDepartureAt: (0, shared_2.toDate)(input.actualDepartureAt) ?? undefined,
                    actualArrivalAt: (0, shared_2.toDate)(input.actualArrivalAt) ?? undefined,
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
                    plannedDepartureAt: (0, shared_2.toDate)(input.plannedDepartureAt),
                    plannedArrivalAt: (0, shared_2.toDate)(input.plannedArrivalAt),
                    actualDepartureAt: (0, shared_2.toDate)(input.actualDepartureAt),
                    actualArrivalAt: (0, shared_2.toDate)(input.actualArrivalAt),
                    notes: input.notes ?? null,
                    metadata: input.metadata ?? undefined,
                },
            });
        }
        await (0, analyticsOutbox_1.enqueueCargoPilotDomainEventsTx)(tx, [
            {
                type: "order_status_changed",
                tenantScope: (0, shared_2.resolveActorTenantScope)(actor),
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
