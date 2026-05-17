"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listPricingComponents = listPricingComponents;
exports.createPricingComponent = createPricingComponent;
const client_1 = require("@prisma/client");
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const analyticsOutbox_1 = require("../analytics-core/infrastructure/analyticsOutbox");
const shared_1 = require("../orders-core/shared");
const shared_2 = require("./shared");
async function listPricingComponents(orderId) {
    await (0, shared_2.ensureOrderExists)(orderId);
    return prismaClient_1.default.pricingComponent.findMany({
        where: { orderId },
        orderBy: [{ createdAt: "desc" }],
    });
}
async function createPricingComponent(orderId, input, actor) {
    await (0, shared_2.ensureOrderExists)(orderId);
    if (!Number.isFinite(input.amount)) {
        throw (0, shared_1.orderError)("amount must be a finite number", 400);
    }
    if (!input.currency || !input.currency.trim()) {
        throw (0, shared_1.orderError)("currency is required", 400);
    }
    return prismaClient_1.default.$transaction(async (tx) => {
        if (input.orderLegId) {
            const leg = await tx.orderLeg.findFirst({
                where: { id: input.orderLegId, orderId },
                select: { id: true },
            });
            if (!leg) {
                throw (0, shared_1.orderError)("orderLegId is invalid for this order", 400);
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
                tenantScope: (0, shared_2.resolveActorTenantScope)(actor),
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
