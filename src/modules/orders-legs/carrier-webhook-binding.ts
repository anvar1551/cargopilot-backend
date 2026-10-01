import { createHash } from "crypto";
import { isDeepStrictEqual } from "util";
import { orderError } from "../orders-core/shared/actor";
import { loadAcceptedCarrierOperation } from "./carrier-worker-authority";

function deny(): never { throw orderError("Carrier webhook binding is unsupported, ambiguous or inconsistent", 403); }
function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
function reference(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) deny();
  return value.trim();
}

/** Only the repository-demonstrated sandbox HMAC JSON status contract is supported. */
export async function bindCarrierWebhook(tx: any, event: any) {
  if (!event.webhookEventId || event.outboxId || event.eventType !== "carrier.status.updated") deny();
  await tx.$queryRaw`SELECT "id" FROM "IntegrationWebhookEvent" WHERE "id" = ${event.webhookEventId}::uuid FOR SHARE`;
  const raw = await tx.integrationWebhookEvent.findUnique({ where: { id: event.webhookEventId }, include: { canonicalEvent: true } });
  if (!raw?.signatureVerified || !raw.providerId || !raw.companyId || raw.domain !== "carrier" ||
      raw.rawBodySha256 !== createHash("sha256").update(raw.rawBody).digest("hex")) deny();
  const provider = await tx.integrationProvider.findUnique({ where: { id: raw.providerId } });
  if (!provider || provider.status !== "active" || provider.domain !== "carrier" ||
      provider.providerCode !== "fake_carrier" || provider.environment !== "sandbox" ||
      raw.environment !== provider.environment || raw.companyId !== provider.companyId ||
      raw.providerCode !== provider.providerCode || event.companyId !== raw.companyId ||
      event.providerId !== raw.providerId || event.providerCode !== raw.providerCode) deny();
  const normalized = raw.canonicalEvent;
  if (!normalized || normalized.companyId !== raw.companyId || normalized.domain !== "carrier" ||
      normalized.providerCode !== raw.providerCode || normalized.eventType !== event.eventType ||
      !isDeepStrictEqual(normalized.payloadJson, event.payloadJson)) deny();
  let payload: Record<string, any>;
  try { payload = object(JSON.parse(raw.rawBody)); } catch { deny(); }
  if (!isDeepStrictEqual(payload, normalized.payloadJson)) deny();
  if (payload.eventType !== "carrier.status.updated" || !reference(payload.statusCode)) deny();
  for (const key of ["status", "code", "state"]) {
    if (payload[key] != null && reference(payload[key]) !== reference(payload.statusCode)) deny();
  }
  const bookingRef = reference(payload.partnerShipmentId) ?? reference(payload.shipmentId);
  if (!bookingRef || (payload.shipmentId != null && reference(payload.shipmentId) !== bookingRef)) deny();
  for (const key of ["carrierRef", "shipment_id", "partner_shipment_id"]) {
    if (payload[key] != null && reference(payload[key]) !== bookingRef) deny();
  }
  const candidates = await tx.orderLeg.findMany({
    where: { carrierProviderId: provider.id, carrierRef: bookingRef }, select: { id: true, orderId: true }, take: 2,
  });
  if (candidates.length !== 1) deny();
  const candidate = candidates[0];
  await tx.$queryRaw`SELECT l."id" FROM "OrderLeg" l WHERE l."id" = ${candidate.id}::uuid FOR UPDATE`;
  const bookings = await tx.integrationOutbox.findMany({ where: {
    providerId: provider.id, companyId: provider.companyId, domain: "carrier", operation: "create_shipment",
    aggregateType: "shipment", aggregateId: candidate.id, ownershipOrderId: candidate.orderId,
    acceptedAt: { not: null }, status: "sent",
  }, select: { id: true }, take: 2 });
  if (bookings.length !== 1) deny();
  await tx.$queryRaw`SELECT o."id" FROM "IntegrationOutbox" b
    JOIN "Order" o ON o."id" = b."ownershipOrderId"
    JOIN "Tenant" t ON t."id" = o."tenantId" JOIN "Organization" c ON c."id" = o."ownerOrgId"
    JOIN "IntegrationProvider" p ON p."id" = b."providerId"
    WHERE b."id" = ${bookings[0].id}::uuid FOR SHARE OF b, o, t, c, p`;
  const { row, leg } = await loadAcceptedCarrierOperation(tx, bookings[0].id);
  if (row.operation !== "create_shipment" || row.status !== "sent" || leg.id !== candidate.id ||
      row.companyId !== raw.companyId || row.providerId !== raw.providerId ||
      leg.carrierRef !== bookingRef || leg.carrierBookingStatus !== "booked") deny();
  const attempt = await tx.integrationDeliveryAttempt.findUnique({ where: {
    outboxId_attemptNo: { outboxId: row.id, attemptNo: row.attemptCount },
  } });
  if (!attempt || attempt.outcome !== "success" || reference(attempt.responseJson?.partnerShipmentId) !== bookingRef) deny();
  const expected: Record<string, string> = {
    tenantId: row.ownershipTenantId, tenant_id: row.ownershipTenantId,
    companyId: row.companyId, company_id: row.companyId, orgId: row.companyId, organizationId: row.companyId,
    orderId: row.ownershipOrderId, order_id: row.ownershipOrderId,
    legId: leg.id, orderLegId: leg.id, aggregateId: leg.id, aggregate_id: leg.id,
    leg_id: leg.id, order_leg_id: leg.id, resourceId: leg.id, resource_id: leg.id, entityId: leg.id, entity_id: leg.id,
    providerId: provider.id, providerCode: provider.providerCode, environment: provider.environment,
  };
  for (const claims of [payload, object(payload.metadata), object(object(payload.input).metadata)]) {
    for (const [key, value] of Object.entries(expected)) if (claims[key] != null && reference(claims[key]) !== value) deny();
  }
  if (payload.aggregateType != null && payload.aggregateType !== "shipment") deny();
  if (payload.trackingNumber != null && reference(payload.trackingNumber) !== leg.carrierTrackingNumber) deny();
  return { event: { ...event, companyId: row.companyId, aggregateType: "shipment", aggregateId: leg.id,
    payloadJson: payload, occurredAt: normalized.occurredAt.toISOString() }, leg };
}

/** Inbound-only policy: operational progression, no terminal corrections or reopen. */
export function assertCarrierWebhookTransition(current: string, next: string | null) {
  const allowed: Record<string, string[]> = {
    booked: ["booked", "departed", "in_transit", "exception", "cancelled"],
    departed: ["departed", "in_transit", "arrived", "exception"],
    in_transit: ["in_transit", "arrived", "completed", "exception"],
    arrived: ["arrived", "completed", "exception"],
    completed: ["completed"], cancelled: ["cancelled"], exception: ["exception"],
  };
  if (!next || !allowed[current]?.includes(next)) throw orderError("Carrier webhook transition is not permitted", 409);
}
