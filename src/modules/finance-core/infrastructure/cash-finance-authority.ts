import { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import { financeConflict } from "../domain/finance.errors";
import { financeSourceEventHash, normalizeFinanceSourceEvent } from "../domain/source-event";

function deny(): never { throw financeConflict("Accepted cash finance authority is missing or inconsistent", "FINANCE_CASH_AUTHORITY_REJECTED"); }
function exact(value: unknown) {
  const text = String(value ?? "");
  if (!/^\d{1,16}(?:\.\d{1,4})?$/.test(text)) return deny();
  const amount = new Prisma.Decimal(text);
  if (!amount.isPositive()) return deny();
  return amount.toFixed(4);
}

/** Narrow durable capability: derive one finance event from an accepted cash receipt.
 * No human login/membership is impersonated or required to remain logged in.
 * FX/date basis is the committed acceptance outbox snapshot, never Redis/current pricing.
 */
export async function loadAcceptedCashFinance(tx: Prisma.TransactionClient, sourceEventId: string) {
  const match = /^cash:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(sourceEventId);
  if (!match) return deny();
  const eventId = match[1];
  const identity = await tx.cashCustodyOperation.findUnique({ where: { eventId }, select: { orderId: true } });
  if (!identity) return deny();
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${identity.orderId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT op."id" FROM "CashCustodyOperation" op
    JOIN "CashCollectionEvent" ev ON ev."id" = op."eventId"
    JOIN "CashCollection" cc ON cc."id" = op."collectionId"
    WHERE op."eventId" = ${eventId}::uuid FOR SHARE OF op, ev, cc`;
  await tx.$queryRaw`SELECT "id" FROM "AnalyticsDomainEventOutbox" WHERE "eventId" = ${`finance:${sourceEventId}`} FOR SHARE`;
  const operation = await tx.cashCustodyOperation.findUnique({ where: { eventId }, include: { event: true, collection: true, order: true } });
  const outbox = await tx.analyticsDomainEventOutbox.findUnique({ where: { eventId: `finance:${sourceEventId}` } });
  if (!operation || !outbox || !operation.tenantId || !operation.companyId) return deny();
  const { order, collection, event } = operation;
  await tx.$queryRaw`SELECT t."id" FROM "Tenant" t JOIN "Organization" c ON c."tenantId" = t."id"
    JOIN "FinanceLegalEntity" f ON f."companyId" = c."id" AND f."tenantId" = t."id"
    WHERE t."id" = ${operation.tenantId}::uuid AND c."id" = ${operation.companyId}::uuid FOR SHARE OF t, c, f`;
  const entity = await tx.financeLegalEntity.findUnique({ where: { companyId: operation.companyId },
    include: { company: true, tenant: true } });
  if (!entity?.isActive || entity.companyId !== operation.companyId || entity.tenantId !== operation.tenantId ||
      entity.tenant?.id !== operation.tenantId || entity.tenant.status !== "active" ||
      entity.company.id !== operation.companyId || entity.company.tenantId !== operation.tenantId || !entity.company.isActive ||
      order.id !== operation.orderId || order.tenantId !== operation.tenantId || order.ownerOrgId !== operation.companyId ||
      collection.orderId !== order.id || collection.id !== operation.collectionId || event.cashCollectionId !== collection.id ||
      event.id !== operation.eventId || event.actorId !== operation.actorId ||
      !["cod", "service_charge"].includes(collection.kind)) return deny();
  const eventType = ({ collect: "cash.collected", handoff: "cash.handed_off", settle: "cash.settled" } as Record<string, string>)[operation.action];
  const custodyType = ({ collect: "collected", handoff: "handoff", settle: "settled" } as Record<string, string>)[operation.action];
  if (!eventType || !event.fromHolderType || !event.toHolderType || event.eventType !== custodyType || operation.currency !== order.currency ||
      collection.currency !== operation.currency || exact(event.amount) !== exact(operation.amount) ||
      exact(collection.expectedAmount) !== exact(operation.amount) || exact(collection.collectedAmount) !== exact(operation.amount)) return deny();
  const payload = outbox.payload as unknown as Record<string, any>;
  if (outbox.type !== "finance_source_event" || outbox.schemaVersion !== 1 || outbox.entityId !== order.id ||
      outbox.tenantScope !== `company:${operation.companyId}` || outbox.occurredAt.getTime() !== event.createdAt.getTime() ||
      payload.tenantId !== operation.tenantId || payload.companyId !== operation.companyId ||
      payload.metadata?.baseCurrency !== entity.baseCurrency || typeof payload.fxRate !== "string" ||
      !payload.fxRateAsOf || !Number.isFinite(new Date(payload.fxRateAsOf).getTime()) ||
      new Date(payload.fxRateAsOf).getTime() > event.createdAt.getTime()) return deny();
  let warehouseId: string | undefined;
  if (["warehouse", "pickup_point"].includes(event.toHolderType)) {
    if (!event.toHolderId) return deny();
    await tx.$queryRaw`SELECT "id" FROM "Warehouse" WHERE "id" = ${event.toHolderId}::uuid FOR SHARE`;
    const warehouse = await tx.warehouse.findFirst({ where: { id: event.toHolderId, tenantId: operation.tenantId }, select: { id: true } });
    if (!warehouse) return deny();
    warehouseId = warehouse.id;
  }
  const expected = normalizeFinanceSourceEvent({ schemaVersion: 1, sourceEventId, companyId: operation.companyId,
    sourceType: "cash_custody", eventType, sourceId: collection.id, actorUserId: operation.actorId,
    occurredAt: event.createdAt, documentDate: event.createdAt, postingDate: event.createdAt,
    currency: operation.currency, fxRate: exact(payload.fxRate), fxRateAsOf: payload.fxRateAsOf,
    amounts: { [collection.kind === "cod" ? "cod_amount" : "service_charge"]: exact(operation.amount) },
    dimensions: { orderId: order.id, warehouseId },
    attributes: { cashKind: collection.kind, fromHolderType: event.fromHolderType, toHolderType: event.toHolderType },
    metadata: { cashCollectionId: collection.id, cashCollectionEventId: event.id, baseCurrency: entity.baseCurrency } });
  const actual = normalizeFinanceSourceEvent(payload as any);
  if (financeSourceEventHash(actual) !== financeSourceEventHash(expected)) return deny();
  return { event: expected, entity, operation, hash: financeSourceEventHash(expected) };
}

export function assertAcceptedCashSource(record: any, accepted: Awaited<ReturnType<typeof loadAcceptedCashFinance>>) {
  const event = accepted.event;
  if (record.companyId !== event.companyId || record.legalEntityId !== accepted.entity.id ||
      record.sourceEventId !== event.sourceEventId || record.sourceType !== event.sourceType ||
      record.eventType !== event.eventType || record.sourceId !== event.sourceId || record.schemaVersion !== 1 ||
      record.payloadHash !== accepted.hash || record.occurredAt.getTime() !== event.occurredAt.getTime() ||
      record.postingDate.toISOString().slice(0, 10) !== event.postingDate.toISOString().slice(0, 10) ||
      financeSourceEventHash(normalizeFinanceSourceEvent(record.payloadJson)) !== accepted.hash) return deny();
}

export async function ingestAcceptedCashOutbox(outboxEventId: string) {
  if (!outboxEventId.startsWith("finance:cash:")) return deny();
  const sourceEventId = outboxEventId.slice("finance:".length);
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`cash-finance:${sourceEventId}`}, 0))::text`;
    const accepted = await loadAcceptedCashFinance(tx, sourceEventId);
    const existing = await tx.financeSourceEvent.findUnique({ where: { companyId_sourceEventId: {
      companyId: accepted.event.companyId, sourceEventId } } });
    if (existing) { assertAcceptedCashSource(existing, accepted); return { event: existing, idempotent: true }; }
    const event = accepted.event;
    const row = await tx.financeSourceEvent.create({ data: { companyId: event.companyId, legalEntityId: accepted.entity.id,
      sourceEventId, sourceType: event.sourceType, eventType: event.eventType, sourceId: event.sourceId,
      schemaVersion: 1, occurredAt: event.occurredAt, postingDate: event.postingDate,
      payloadHash: accepted.hash, payloadJson: JSON.parse(JSON.stringify(event)) } });
    return { event: row, idempotent: false };
  }, { maxWait: 3000, timeout: 10000 });
}
