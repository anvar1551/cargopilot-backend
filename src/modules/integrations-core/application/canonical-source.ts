import { createHash } from "crypto";
import { isDeepStrictEqual } from "util";
import type { Prisma } from "@prisma/client";
import type { EnqueueIntegrationCanonicalEventInput } from "./canonical-event.types";
import { loadAcceptedCarrierOperation } from "../../orders-legs/carrier-worker-authority";
import { authorityError } from "../../orders-core/domain/creation-authority";

function deny(): never { throw Object.assign(authorityError("Canonical source is missing or inconsistent", 409), { code: "INTEGRATION_CANONICAL_SOURCE_REQUIRED" }); }
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
/** Metadata persistence authority only. Business application still requires its domain executor. */
export async function deriveCanonicalSource(tx: Prisma.TransactionClient, input: EnqueueIntegrationCanonicalEventInput) {
  let source: { companyId: string; providerId: string; domain: any; providerCode: string; environment: any };
  let eventType: string, aggregateType: string | null, aggregateId: string | null, payloadJson: any, occurredAt: Date;
  if (input.source === "outbound_response") {
    if (!input.outboxId || input.webhookEventId) deny();
    await tx.$queryRaw`SELECT id FROM "IntegrationOutbox" WHERE id=${input.outboxId}::uuid FOR SHARE`;
    const accepted = await loadAcceptedCarrierOperation(tx, input.outboxId);
    const row = accepted.row;
    const attempt = await tx.integrationDeliveryAttempt.findFirst({ where: { outboxId: row.id }, orderBy: { attemptNo: "desc" } });
    if (!attempt || attempt.attemptNo !== row.attemptCount ||
      !((row.status === "sent" && attempt.outcome === "success") || (row.status === "dead_letter" && attempt.outcome === "dead_letter"))) deny();
    source = row; aggregateType = "shipment"; aggregateId = accepted.leg.id; occurredAt = attempt.finishedAt;
    if (row.operation === "create_shipment") {
      eventType = attempt.outcome === "success" ? "carrier.shipment.created" : "carrier.shipment.failed";
      payloadJson = { requestJson: attempt.requestJson ?? null, responseJson: attempt.responseJson ?? null,
        providerRequestId: attempt.providerRequestId ?? null, statusCode: attempt.statusCode,
        ...(attempt.outcome === "success" ? {} : { message: attempt.errorMessage }) };
    } else {
      if (attempt.outcome !== "success") deny();
      eventType = "carrier.status.updated";
      payloadJson = { ...object(attempt.responseJson), providerRequestId: attempt.providerRequestId ?? null,
        providerHttpStatusCode: attempt.statusCode,
        ...(row.operation === "cancel_shipment" ? { statusCode: "cancelled", statusLabel: "Cancelled" } : {}) };
    }
  } else if (input.source === "inbound_webhook") {
    if (!input.webhookEventId || input.outboxId) deny();
    await tx.$queryRaw`SELECT id FROM "IntegrationWebhookEvent" WHERE id=${input.webhookEventId}::uuid FOR SHARE`;
    const raw = await tx.integrationWebhookEvent.findUnique({ where: { id: input.webhookEventId }, include: { canonicalEvent: true } });
    const normalized = raw?.canonicalEvent;
    if (!raw?.signatureVerified || !raw.companyId || !raw.providerId || !normalized ||
      raw.rawBodySha256 !== createHash("sha256").update(raw.rawBody).digest("hex") ||
      normalized.companyId !== raw.companyId || normalized.domain !== raw.domain || normalized.providerCode !== raw.providerCode) deny();
    source = { ...raw, companyId: raw.companyId, providerId: raw.providerId };
    eventType = normalized.eventType; aggregateType = normalized.aggregateType; aggregateId = normalized.aggregateId;
    payloadJson = normalized.payloadJson; occurredAt = normalized.occurredAt;
  } else deny();
  const provider = await tx.integrationProvider.findUnique({ where: { id: source.providerId }, select: {
    companyId: true, domain: true, providerCode: true, environment: true, status: true,
    company: { select: { id: true, tenantId: true, type: true, isActive: true, tenant: { select: { id: true, status: true } } } },
  } });
  if (!provider || provider.status !== "active" || provider.companyId !== source.companyId || provider.domain !== source.domain ||
    provider.providerCode !== source.providerCode || provider.environment !== source.environment ||
    provider.company.id !== source.companyId || provider.company.type !== "company" || !provider.company.isActive ||
    !provider.company.tenantId || provider.company.tenant?.id !== provider.company.tenantId || provider.company.tenant.status !== "active") deny();
  if ((input.companyId !== undefined && input.companyId !== source.companyId) ||
    (input.providerId !== undefined && input.providerId !== source.providerId) || input.domain !== source.domain || input.providerCode !== source.providerCode ||
    input.eventType !== eventType || (input.aggregateType ?? null) !== aggregateType || (input.aggregateId ?? null) !== aggregateId ||
    new Date(input.occurredAt).getTime() !== occurredAt.getTime() || !isDeepStrictEqual(input.payloadJson, payloadJson)) deny();
  return { source: input.source, companyId: source.companyId, providerId: source.providerId,
    webhookEventId: input.source === "inbound_webhook" ? input.webhookEventId! : null,
    outboxId: input.source === "outbound_response" ? input.outboxId! : null,
    domain: source.domain, providerCode: source.providerCode, eventType, aggregateType, aggregateId, payloadJson, occurredAt };
}
