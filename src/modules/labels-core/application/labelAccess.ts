import prisma from "../../../config/prismaClient";
import { requireAuthorizedOrder } from "../../orders-core/domain/order-access";
import type { OrderActor } from "../../orders-core/shared/actor";
import { orderError } from "../../orders-core/shared/actor";
import { presignGetObject } from "../../../utils/s3Presign";

export async function getOrderLabelUrls(actor: OrderActor | undefined, orderId: string) {
  const authorized = await requireAuthorizedOrder(actor, orderId, "shipment.view");
  const order = await prisma.order.findFirst({
    where: { id: authorized.id, tenantId: authorized.tenantId },
    select: { labelKey: true, parcels: {
      select: { id: true, orderId: true, pieceNo: true, pieceTotal: true, parcelCode: true, labelKey: true },
      orderBy: { pieceNo: "asc" },
    } },
  });
  if (!order) throw orderError("Order not found", 404);
  const labels = order.parcels.filter(parcel => parcel.orderId === authorized.id && Boolean(parcel.labelKey));
  if (!labels.length && order.labelKey) return { url: await presignGetObject(order.labelKey, 300) };
  if (!labels.length) throw orderError("Label not available yet", 404);
  const urls = await Promise.all(labels.map(async parcel => ({
    parcelId: parcel.id, parcelCode: parcel.parcelCode,
    pieceNo: parcel.pieceNo, pieceTotal: parcel.pieceTotal,
    url: await presignGetObject(parcel.labelKey!, 300),
  })));
  return { url: urls[0].url, urls };
}
