import { requireActiveOrderOwnership } from "../orders-core/domain/worker-ownership";
import { orderError } from "../orders-core/shared/actor";

/** The only carrier service capabilities: create, track and cancel one accepted leg. */
export async function loadAcceptedCarrierOperation(db: any, outboxId: string) {
  const row = await db.integrationOutbox.findUnique({ where: { id: outboxId } });
  if (!row || row.domain !== "carrier" || !row.acceptedAt || !row.ownershipTenantId ||
      !row.ownershipOrderId || !row.providerId || row.aggregateType !== "shipment" ||
      !row.aggregateId || !["create_shipment", "track", "cancel_shipment"].includes(row.operation)) {
    throw orderError("Accepted carrier operation required", 403);
  }
  await requireActiveOrderOwnership(db, row.ownershipOrderId, row.ownershipTenantId, row.companyId);
  const provider = await db.integrationProvider.findUnique({ where: { id: row.providerId } });
  if (!provider || provider.companyId !== row.companyId || provider.domain !== "carrier" ||
      provider.status !== "active" || provider.providerCode !== row.providerCode ||
      provider.environment !== row.environment) throw orderError("Carrier provider ownership disagrees", 403);
  const leg = await db.orderLeg.findFirst({ where: { id: row.aggregateId, orderId: row.ownershipOrderId } });
  if (!leg || leg.orderId !== row.ownershipOrderId || leg.carrierProviderId !== provider.id ||
      leg.carrierCode !== provider.providerCode) throw orderError("Carrier child ownership disagrees", 403);
  const envelope = row.payload;
  if (!envelope || envelope.companyId !== row.companyId || envelope.aggregateType !== "shipment" ||
      envelope.aggregateId !== leg.id || envelope.payload?.action !== row.operation) {
    throw orderError("Carrier command context disagrees", 403);
  }
  const input = envelope.payload.input;
  if (!input || input.metadata?.orderId !== row.ownershipOrderId || input.metadata?.orderLegId !== leg.id ||
      (row.operation === "track" && (
        (!input.partnerShipmentId && !input.trackingNumber) ||
        (input.partnerShipmentId && input.partnerShipmentId !== leg.carrierRef) ||
        (input.trackingNumber && input.trackingNumber !== leg.carrierTrackingNumber))) ||
      (row.operation === "cancel_shipment" && (!leg.carrierRef || input.partnerShipmentId !== leg.carrierRef))) {
    throw orderError("Carrier command child reference disagrees", 403);
  }
  return { row, leg, provider };
}
