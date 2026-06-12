"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteOrderForActor = deleteOrderForActor;
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const identity_access_1 = require("../../identity-access");
const repo_1 = require("../repo");
const shared_1 = require("../shared");
function isEmptyWhere(value) {
    return !value || (typeof value === "object" && Object.keys(value).length === 0);
}
async function deleteOrderForActor(args) {
    const orderId = String(args.orderId || "").trim();
    if (!orderId) {
        throw (0, shared_1.orderError)("orderId is required", 400);
    }
    await (0, identity_access_1.authorize)(args.actor, "shipment.delete");
    const scopeWhere = await (0, identity_access_1.buildOrderScopeWhere)(args.actor);
    const result = await prismaClient_1.default.$transaction(async (tx) => {
        const order = await tx.order.findFirst({
            where: scopeWhere && !isEmptyWhere(scopeWhere)
                ? { AND: [{ id: orderId }, scopeWhere] }
                : { id: orderId },
            select: { id: true, orderNumber: true },
        });
        if (!order) {
            throw (0, shared_1.orderError)("Order not found", 404);
        }
        const legs = await tx.orderLeg.findMany({
            where: { orderId },
            select: { id: true },
        });
        const legIds = legs.map((leg) => leg.id);
        const aggregateIds = [orderId, ...legIds];
        const paymentIntents = await tx.paymentIntent.findMany({
            where: { orderId },
            select: { id: true },
        });
        const paymentIntentIds = paymentIntents.map((intent) => intent.id);
        const cashCollections = await tx.cashCollection.findMany({
            where: { orderId },
            select: { id: true },
        });
        const cashCollectionIds = cashCollections.map((item) => item.id);
        const integrationOutboxes = await tx.integrationOutbox.findMany({
            where: { aggregateId: { in: aggregateIds } },
            select: { id: true },
        });
        const integrationOutboxIds = integrationOutboxes.map((item) => item.id);
        const integrationCanonicalWhere = [
            { aggregateId: { in: aggregateIds } },
            ...(integrationOutboxIds.length
                ? [{ outboxId: { in: integrationOutboxIds } }]
                : []),
        ];
        const deleted = {
            integrationCanonicalEvents: (await tx.integrationCanonicalEvent.deleteMany({
                where: { OR: integrationCanonicalWhere },
            })).count,
            integrationDeliveryAttempts: integrationOutboxIds.length
                ? (await tx.integrationDeliveryAttempt.deleteMany({
                    where: { outboxId: { in: integrationOutboxIds } },
                })).count
                : 0,
            integrationOutboxes: (await tx.integrationOutbox.deleteMany({
                where: { id: { in: integrationOutboxIds } },
            })).count,
            paymentWebhookEvents: paymentIntentIds.length
                ? (await tx.paymentWebhookEvent.deleteMany({
                    where: { paymentIntentId: { in: paymentIntentIds } },
                })).count
                : 0,
            paymentLedgerEntries: (await tx.paymentLedgerEntry.deleteMany({ where: { orderId } })).count,
            paymentAttempts: paymentIntentIds.length
                ? (await tx.paymentAttempt.deleteMany({
                    where: { paymentIntentId: { in: paymentIntentIds } },
                })).count
                : 0,
            paymentIntents: (await tx.paymentIntent.deleteMany({ where: { orderId } })).count,
            cashCollectionEvents: cashCollectionIds.length
                ? (await tx.cashCollectionEvent.deleteMany({
                    where: { cashCollectionId: { in: cashCollectionIds } },
                })).count
                : 0,
            cashCollections: (await tx.cashCollection.deleteMany({ where: { orderId } })).count,
            trackingEvents: (await tx.tracking.deleteMany({ where: { orderId } })).count,
            labelJobs: (await tx.orderLabelJob.deleteMany({ where: { orderId } })).count,
            attachments: (await tx.orderAttachment.deleteMany({ where: { orderId } })).count,
            invoices: (await tx.invoice.deleteMany({ where: { orderId } })).count,
            orderDocuments: (await tx.orderDocument.deleteMany({ where: { orderId } })).count,
            pricingComponents: (await tx.pricingComponent.deleteMany({ where: { orderId } })).count,
            parcels: (await tx.parcel.deleteMany({ where: { orderId } })).count,
            legs: (await tx.orderLeg.deleteMany({ where: { orderId } })).count,
            supportTicketsDetached: (await tx.supportTicket.updateMany({
                where: { orderId },
                data: { orderId: null },
            })).count,
            notificationsDetached: (await tx.userNotification.updateMany({
                where: { orderId },
                data: { orderId: null },
            })).count,
        };
        await tx.order.delete({ where: { id: orderId } });
        return {
            deleted: true,
            orderId: order.id,
            orderNumber: order.orderNumber,
            cleanup: deleted,
        };
    });
    (0, repo_1.clearOrderListCache)();
    return result;
}
