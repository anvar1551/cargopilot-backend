import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import { enqueueCargoPilotDomainEventsTx } from "../../analytics-core/infrastructure/analyticsOutbox";
import { orderError, type OrderActor } from "../shared/actor";
import { cashDatabase as db, cashWarehouse, exactCashAmount, requireCashContext } from "./cash-authority";

type Input = { actor: OrderActor; orderId: string; kind: "cod" | "service_charge";
  operationId: string; expectedEventId?: string | null; note?: string | null;
  amount?: unknown; toHolderType?: "driver" | "warehouse" | "pickup_point";
  toDriverId?: string | null; toWarehouseId?: string | null };
type Action = "collect" | "handoff" | "settle";

function validate(input: Input, action: Action) {
  const allowed = new Set(["actor", "orderId", "kind", "operationId", "expectedEventId", "note",
    ...(action === "collect" ? ["amount"] : action === "handoff" ? ["toHolderType", "toDriverId", "toWarehouseId"] : [])]);
  if (Object.keys(input).some(k => !allowed.has(k)) || input.amount != null) throw orderError("Caller financial or ownership authority is forbidden", 400);
  if (!["cod", "service_charge"].includes(input.kind) || !/^[A-Za-z0-9:_-]{8,100}$/.test(input.operationId ?? "")) {
    throw orderError("Valid kind and operationId required", 400);
  }
  if (input.note != null && (typeof input.note !== "string" || input.note.length > 500)) throw orderError("Bounded note required", 400);
  if (action !== "collect" && !/^[0-9a-f-]{36}$/i.test(input.expectedEventId ?? "")) throw orderError("expectedEventId required", 400);
}

async function execute(input: Input, action: Action) {
  validate(input, action);
  const permission = action === "settle" ? "finance.settleCash" : "shipment.update";
  const initial = await requireCashContext(input.actor, permission);
  return db.$transaction(async (tx: any) => {
    // A bounded order lock serializes initialization and incompatible custody actions.
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${input.orderId}::uuid FOR UPDATE`;
    const { actor, scope } = await requireCashContext(initial.actor, permission);
    const order = await tx.order.findFirst({ where: { AND: [{ id: input.orderId }, scope] },
      select: { id: true, orderNumber: true, status: true, tenantId: true, ownerOrgId: true,
        assignedDriverId: true, currentWarehouseId: true, codAmount: true, codPaidStatus: true,
        serviceCharge: true, serviceChargePaidStatus: true, deliveryChargePaidBy: true, currency: true, paymentType: true,
        pricingComponents: { select: { currency: true, fxRateSnapshot: true, baseCurrency: true, createdAt: true } } } });
    if (!order || order.tenantId !== actor.tenantId || order.ownerOrgId !== actor.companyId) throw orderError("Order not found in selected cash context", 404);
    await tx.$queryRaw`SELECT t."id" FROM "Tenant" t JOIN "Organization" c ON c."tenantId" = t."id"
      JOIN "FinanceLegalEntity" f ON f."companyId" = c."id" AND f."tenantId" = t."id"
      WHERE t."id" = ${order.tenantId}::uuid AND c."id" = ${order.ownerOrgId}::uuid FOR SHARE OF t, c, f`;
    const legalEntity = await tx.financeLegalEntity.findUnique({ where: { companyId: order.ownerOrgId },
      include: { tenant: { select: { id: true, status: true } }, company: { select: { id: true, tenantId: true, isActive: true } } } });
    if (!legalEntity?.isActive || legalEntity.tenantId !== order.tenantId || legalEntity.tenant?.status !== "active" ||
        legalEntity.tenant.id !== order.tenantId || legalEntity.company?.id !== order.ownerOrgId ||
        legalEntity.company.tenantId !== order.tenantId || !legalEntity.company.isActive) throw orderError("Cash legal-entity ownership required", 403);
    if (!["assigned", "pickup_in_progress", "picked_up", "at_warehouse", "in_transit", "out_for_delivery", "delivered"].includes(order.status)) throw orderError("Order state does not permit cash operations", 409);
    const fingerprint = createHash("sha256").update(JSON.stringify({ action, actorId: actor.id,
      membershipId: actor.companyMembershipId, orderId: order.id, kind: input.kind,
      expectedEventId: input.expectedEventId ?? null, note: input.note ?? null,
      toHolderType: input.toHolderType ?? null, toDriverId: input.toDriverId ?? null,
      toWarehouseId: input.toWarehouseId ?? null })).digest("hex");
    const prior = await tx.cashCustodyOperation.findUnique({ where: { tenantId_companyId_operationKey: {
      tenantId: actor.tenantId, companyId: actor.companyId, operationKey: input.operationId } } });
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw orderError("Conflicting cash operation reuse", 409);
      return prior.resultJson;
    }
    await tx.$queryRaw`SELECT "id" FROM "CashCollection" WHERE "orderId" = ${order.id}::uuid AND "kind"::text = ${input.kind} FOR UPDATE`;
    let collection = await tx.cashCollection.findUnique({ where: { orderId_kind: { orderId: order.id, kind: input.kind } },
      include: { events: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 } } });
    const currency = String(order.currency ?? "");
    if (!/^[A-Z]{3}$/.test(currency)) throw orderError("Authoritative cash currency required", 409);
    const components = order.pricingComponents;
    const rates = new Set(components.map((p: any) => p.fxRateSnapshot?.toString()).filter(Boolean));
    const bases = new Set(components.map((p: any) => p.baseCurrency).filter(Boolean));
    if (!components.length || components.some((p: any) => p.currency !== currency || p.fxRateSnapshot == null) || rates.size !== 1 || bases.size !== 1 || Array.from(bases)[0] !== legalEntity.baseCurrency || !new Prisma.Decimal(String(Array.from(rates)[0])).isPositive()) {
      throw orderError("Complete authoritative cash FX snapshot required", 409);
    }
    let amount: Prisma.Decimal;
    let toType: string, toUser: string | null = null, toWarehouse: string | null = null, toLabel: string;
    let fromType = "none", fromId: string | null = null, fromLabel: string | null = null;
    if (action === "collect") {
      const value = input.kind === "cod" ? order.codAmount : order.serviceCharge;
      const paid = input.kind === "cod" ? order.codPaidStatus : order.serviceChargePaidStatus;
      if (input.kind === "service_charge" && ["CARD", "TRANSFER"].includes(order.paymentType)) throw orderError("Online service-charge obligation cannot be collected as cash", 409);
      if (paid !== "NOT_PAID" || (input.kind === "service_charge" && !["SENDER", "RECIPIENT"].includes(order.deliveryChargePaidBy))) throw orderError("No collectible cash obligation", 409);
      amount = exactCashAmount(value);
      if (collection && (collection.status !== "expected" || collection.currentHolderType !== "none" ||
          collection.currentHolderUserId || collection.currentHolderWarehouseId || collection.collectedAmount != null ||
          !amount.eq(exactCashAmount(collection.expectedAmount)) || collection.currency !== currency)) {
        throw orderError("Cash obligation or initial custody disagrees", 409);
      }
      if (order.assignedDriverId === actor.id) {
        toType = "driver"; toUser = actor.id; toLabel = "Driver";
      } else if (actor.warehouseId && order.currentWarehouseId === actor.warehouseId) {
        const warehouse = await cashWarehouse(tx, actor, actor.warehouseId);
        toType = warehouse.type === "pickup_point" ? "pickup_point" : "warehouse"; toWarehouse = warehouse.id; toLabel = warehouse.name;
      } else throw orderError("Assigned collector or scoped current warehouse required", 403);
      if (!collection) collection = await tx.cashCollection.create({ data: { orderId: order.id, kind: input.kind,
        expectedAmount: amount.toNumber(), currency, status: "expected" } });
    } else {
      if (!collection || collection.status !== "held" || collection.currency !== currency) throw orderError("Bound held cash required", 409);
      const latest = collection.events?.[0];
      if (!latest || latest.id !== input.expectedEventId) throw orderError("Cash custody changed; reload before a new operation", 409);
      const accepted = await tx.cashCustodyOperation.findUnique({ where: { eventId: latest.id } });
      if (!accepted || accepted.tenantId !== order.tenantId || accepted.companyId !== order.ownerOrgId ||
          accepted.orderId !== order.id || accepted.collectionId !== collection.id || accepted.currency !== currency) {
        throw orderError("Legacy or inconsistent cash custody is not accepted", 409);
      }
      amount = exactCashAmount(accepted.amount);
      if (!amount.eq(exactCashAmount(collection.collectedAmount)) || !amount.eq(exactCashAmount(collection.expectedAmount))) throw orderError("Cash monetary custody disagrees", 409);
      fromType = collection.currentHolderType;
      fromId = collection.currentHolderUserId ?? collection.currentHolderWarehouseId;
      fromLabel = collection.currentHolderLabel;
      if (fromType === "driver") {
        if (!collection.currentHolderUserId || collection.currentHolderWarehouseId || collection.currentHolderUserId !== order.assignedDriverId) throw orderError("Driver custody disagrees with assignment", 403);
      } else if (["warehouse", "pickup_point"].includes(fromType)) {
        if (!collection.currentHolderWarehouseId || collection.currentHolderUserId) throw orderError("Warehouse custody is inconsistent", 403);
        await cashWarehouse(tx, actor, collection.currentHolderWarehouseId);
      } else throw orderError("Custody holder unsupported", 409);
      if (action === "settle") {
        const collector = await tx.cashCollectionEvent.findFirst({ where: { cashCollectionId: collection.id, eventType: "collected" }, orderBy: { createdAt: "asc" } });
        if (!collector?.actorId || collector.actorId === actor.id || latest.actorId === actor.id || collection.currentHolderUserId === actor.id) {
          throw orderError("Settlement requires a separate maker and checker", 403);
        }
        toType = "finance"; toLabel = "Finance";
      } else {
        if ((fromType === "driver" && collection.currentHolderUserId !== actor.id) ||
            (["warehouse", "pickup_point"].includes(fromType) && actor.warehouseId !== collection.currentHolderWarehouseId)) {
          throw orderError("Only the verified current custodian may hand off cash", 403);
        }
        if (input.toHolderType === "driver") {
          if (!input.toDriverId || input.toDriverId !== order.assignedDriverId || input.toWarehouseId) throw orderError("Assigned target driver required", 403);
          const memberships = await tx.companyMembership.findMany({ where: { userId: input.toDriverId, companyId: actor.companyId,
            tenantId: actor.tenantId, status: "active", tenantMembership: { status: "active", tenantId: actor.tenantId, userId: input.toDriverId } }, take: 2 });
          const driver = await tx.user.findUnique({ where: { id: input.toDriverId }, select: { id: true, driverType: true } });
          if (memberships.length !== 1 || !driver?.driverType) throw orderError("Target driver membership required", 403);
          toType = "driver"; toUser = driver.id; toLabel = "Driver";
        } else {
          if (!["warehouse", "pickup_point"].includes(input.toHolderType ?? "") || !input.toWarehouseId || input.toDriverId) throw orderError("Explicit target warehouse required", 400);
          const warehouse = await cashWarehouse(tx, actor, input.toWarehouseId);
          toType = warehouse.type === "pickup_point" ? "pickup_point" : "warehouse";
          if (toType !== input.toHolderType) throw orderError("Target holder type disagrees", 409);
          toWarehouse = warehouse.id; toLabel = warehouse.name;
        }
        if (fromType === toType && fromId === (toUser ?? toWarehouse)) throw orderError("Cash handoff must change custodian", 409);
      }
    }
    const now = new Date();
    const cashEvent = await tx.cashCollectionEvent.create({ data: { cashCollectionId: collection.id,
      eventType: action === "collect" ? "collected" : action === "handoff" ? "handoff" : "settled",
      amount: amount.toNumber(), actorId: actor.id, note: input.note ?? null,
      fromHolderType: fromType, fromHolderId: fromId, fromHolderName: fromLabel,
      toHolderType: toType!, toHolderId: toUser ?? toWarehouse, toHolderName: toLabel!, createdAt: now } });
    const updated = await tx.cashCollection.update({ where: { id: collection.id }, data: {
      status: action === "settle" ? "settled" : "held", collectedAmount: amount.toNumber(),
      currentHolderType: toType!, currentHolderUserId: toUser, currentHolderWarehouseId: toWarehouse,
      currentHolderLabel: toLabel!, ...(action === "collect" ? { collectedAt: now } : {}),
      ...(action === "settle" ? { settledAt: now } : {}), note: input.note ?? collection.note ?? null } });
    if (action === "collect") await tx.order.update({ where: { id: order.id }, data: input.kind === "cod" ? { codPaidStatus: "PAID" } : { serviceChargePaidStatus: "PAID" } });
    const result = { id: order.id, orderNumber: order.orderNumber, status: order.status,
      assignedDriverId: order.assignedDriverId, codPaidStatus: input.kind === "cod" && action === "collect" ? "PAID" : order.codPaidStatus,
      serviceChargePaidStatus: input.kind === "service_charge" && action === "collect" ? "PAID" : order.serviceChargePaidStatus,
      cashCollections: [{ id: updated.id, kind: updated.kind, status: updated.status, currency,
        expectedAmount: amount.toString(), collectedAmount: amount.toString(), currentHolderType: toType!,
        currentHolderUserId: toUser, currentHolderWarehouseId: toWarehouse, currentHolderLabel: toLabel!,
        events: [{ id: cashEvent.id, eventType: cashEvent.eventType, amount: amount.toString(), createdAt: now.toISOString() }] }] };
    await tx.cashCustodyOperation.create({ data: { tenantId: order.tenantId, companyId: order.ownerOrgId,
      orderId: order.id, collectionId: collection.id, eventId: cashEvent.id,
      actorId: actor.id, companyMembershipId: actor.companyMembershipId, operationKey: input.operationId,
      action, fingerprint, amount, currency, resultJson: result } });
    const sourceEventId = `cash:${cashEvent.id}`;
    await enqueueCargoPilotDomainEventsTx(tx, [{ id: `cash-operation:${cashEvent.id}`,
      type: action === "settle" ? "cash_settled" : "cash_handoff", tenantScope: `company:${order.ownerOrgId}`,
      entityId: order.id, occurredAt: now.toISOString(), payload: { source: "cashCustody", kind: input.kind,
        tenantId: order.tenantId, companyId: order.ownerOrgId, cashOperationEventId: cashEvent.id } },
    { id: `finance:${sourceEventId}`, type: "finance_source_event", tenantScope: `company:${order.ownerOrgId}`,
      entityId: order.id, occurredAt: now.toISOString(), payload: { schemaVersion: 1, sourceEventId,
        tenantId: order.tenantId, companyId: order.ownerOrgId, sourceType: "cash_custody",
        eventType: action === "collect" ? "cash.collected" : action === "settle" ? "cash.settled" : "cash.handed_off",
        sourceId: collection.id, actorUserId: actor.id, occurredAt: now.toISOString(), documentDate: now.toISOString(), postingDate: now.toISOString(),
        currency, fxRate: Array.from(rates)[0], fxRateAsOf: new Date(Math.max(...components.map((p: any) => p.createdAt.getTime()))).toISOString(),
        amounts: { [input.kind === "cod" ? "cod_amount" : "service_charge"]: amount.toFixed(4) },
        dimensions: { orderId: order.id, warehouseId: toWarehouse ?? undefined },
        attributes: { cashKind: input.kind, fromHolderType: fromType, toHolderType: toType! },
        metadata: { cashCollectionId: collection.id, cashCollectionEventId: cashEvent.id, baseCurrency: Array.from(bases)[0] } } }]);
    return result;
  }, { maxWait: 3000, timeout: 10000 });
}

export const collectOrderCash = (input: Input) => execute(input, "collect");
export const handoffOrderCash = (input: Input) => execute(input, "handoff");
export const settleOrderCash = (input: Input) => execute(input, "settle");
