import prisma from "../../../config/prismaClient";
import { authorize, buildOrderScopeWhere } from "../../identity-access";
import { clearOrderListCache } from "../repo";
import { orderError } from "../shared";

type DeleteOrderActor = Express.User;

function isEmptyWhere(value: unknown) {
  return !value || (typeof value === "object" && Object.keys(value as object).length === 0);
}

export async function deleteOrderForActor(args: {
  actor: DeleteOrderActor;
  orderId: string;
}) {
  const orderId = String(args.orderId || "").trim();
  if (!orderId) {
    throw orderError("orderId is required", 400);
  }

  await authorize(args.actor, "shipment.delete");
  const scopeWhere = await buildOrderScopeWhere(args.actor);

  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where:
        scopeWhere && !isEmptyWhere(scopeWhere)
          ? { AND: [{ id: orderId }, scopeWhere] }
          : { id: orderId },
      select: { id: true, orderNumber: true },
    });

    if (!order) {
      throw orderError("Order not found", 404);
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
      integrationCanonicalEvents: (
        await tx.integrationCanonicalEvent.deleteMany({
          where: { OR: integrationCanonicalWhere },
        })
      ).count,
      integrationDeliveryAttempts: integrationOutboxIds.length
        ? (
            await tx.integrationDeliveryAttempt.deleteMany({
              where: { outboxId: { in: integrationOutboxIds } },
            })
          ).count
        : 0,
      integrationOutboxes: (
        await tx.integrationOutbox.deleteMany({
          where: { id: { in: integrationOutboxIds } },
        })
      ).count,
      paymentWebhookEvents: paymentIntentIds.length
        ? (
            await tx.paymentWebhookEvent.deleteMany({
              where: { paymentIntentId: { in: paymentIntentIds } },
            })
          ).count
        : 0,
      paymentLedgerEntries: (
        await tx.paymentLedgerEntry.deleteMany({ where: { orderId } })
      ).count,
      paymentAttempts: paymentIntentIds.length
        ? (
            await tx.paymentAttempt.deleteMany({
              where: { paymentIntentId: { in: paymentIntentIds } },
            })
          ).count
        : 0,
      paymentIntents: (
        await tx.paymentIntent.deleteMany({ where: { orderId } })
      ).count,
      cashCollectionEvents: cashCollectionIds.length
        ? (
            await tx.cashCollectionEvent.deleteMany({
              where: { cashCollectionId: { in: cashCollectionIds } },
            })
          ).count
        : 0,
      cashCollections: (
        await tx.cashCollection.deleteMany({ where: { orderId } })
      ).count,
      trackingEvents: (
        await tx.tracking.deleteMany({ where: { orderId } })
      ).count,
      labelJobs: (
        await tx.orderLabelJob.deleteMany({ where: { orderId } })
      ).count,
      attachments: (
        await tx.orderAttachment.deleteMany({ where: { orderId } })
      ).count,
      invoices: (await tx.invoice.deleteMany({ where: { orderId } })).count,
      orderDocuments: (
        await tx.orderDocument.deleteMany({ where: { orderId } })
      ).count,
      pricingComponents: (
        await tx.pricingComponent.deleteMany({ where: { orderId } })
      ).count,
      parcels: (await tx.parcel.deleteMany({ where: { orderId } })).count,
      legs: (await tx.orderLeg.deleteMany({ where: { orderId } })).count,
      supportTicketsDetached: (
        await tx.supportTicket.updateMany({
          where: { orderId },
          data: { orderId: null },
        })
      ).count,
      notificationsDetached: (
        await tx.userNotification.updateMany({
          where: { orderId },
          data: { orderId: null },
        })
      ).count,
    };

    await tx.order.delete({ where: { id: orderId } });

    return {
      deleted: true,
      orderId: order.id,
      orderNumber: order.orderNumber,
      cleanup: deleted,
    };
  });

  clearOrderListCache();
  return result;
}
