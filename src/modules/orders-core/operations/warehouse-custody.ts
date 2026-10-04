import { createHash, randomUUID } from "crypto";
import { OrderStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "../../../config/prismaClient";
import { requireCustodyActor, ownedCustodyWhere, loadCustodySource, authorizeCustodyAction, authorizeCustodyRetry, authorizeCustodyRead, observeOutgoingCustody, requireCustodyDriver as driver } from "../domain/custody-access";
import { nextDispatchTime } from "../domain/dispatch-batch";
import { persistDispatchNotification } from "../domain/dispatch-notification";
import { enqueueCargoPilotDomainEventsTx } from "../../analytics-core/infrastructure/analyticsOutbox";
import { orderError, type OrderActor } from "../shared";
import { assertDeliveryCashSettled } from "./order-status";

const actions = ["pickup-offer", "intake", "dispatch", "transport-accept", "receive", "last-mile-offer", "last-mile-accept", "deliver"] as const;
const uuid = z.string().uuid().transform(v => v.toLowerCase());
const request = z.object({ operationId: uuid, action: z.enum(actions), expectedEventId: uuid.nullable(),
  expectedUpdatedAt: z.string().datetime(), parcelIds: z.array(uuid).min(1).max(100),
  warehouseId: uuid.optional(), destinationWarehouseId: uuid.optional(), driverMembershipId: uuid.optional(),
  legId: uuid.optional(), pickupTrackingId: uuid.optional(), proofSubmissionId: z.string().min(1).max(100).optional(),
  outgoingDriverReason: z.string().trim().min(10).max(500).refine(v => !/[\x00-\x1f\x7f]/.test(v)).optional(),
}).strict();
const fields: Record<typeof actions[number], string[]> = {
  "pickup-offer": ["destinationWarehouseId", "pickupTrackingId"], intake: ["warehouseId"],
  dispatch: ["warehouseId", "destinationWarehouseId", "driverMembershipId", "legId"],
  "transport-accept": [], receive: ["warehouseId"], "last-mile-offer": ["warehouseId", "driverMembershipId"],
  "last-mile-accept": [], deliver: ["proofSubmissionId"],
};
export const custodyPermission = (action: typeof actions[number]) => `shipment.custody.${action}`;
function deny(message: string): never { throw orderError(message, 409); }
async function warehouse(tx: Prisma.TransactionClient, authority: {actor: OrderActor}, id: string, scoped: boolean) {
  if (scoped && !authority.actor.scopes?.some(s => s.scopeType === "warehouse" && s.scopeRefId === id)) throw orderError("Explicit receiving/origin warehouse scope required", 403);
  if (!await tx.warehouse.findFirst({ where: { id, tenantId: authority.actor.tenantId! }, select: { id: true } })) throw orderError("Owned warehouse required", 403);
}
/** Per-order whole-parcel custody; no provider or storage effects. */
export async function executeWarehouseCustody(actor: OrderActor, orderId: string, raw: unknown) {
  const parsed=request.safeParse(raw);
  const parsedOrder=uuid.safeParse(orderId);
  if(!parsed.success || !parsedOrder.success) throw orderError("Invalid custody intent",400);
  orderId=parsedOrder.data;
  const input = parsed.data, required = fields[input.action];
  const optional = ["intake", "receive"].includes(input.action) ? ["outgoingDriverReason"] : [];
  if (Object.keys(input).some(k => !["operationId", "action", "expectedEventId", "expectedUpdatedAt", "parcelIds", ...required, ...optional].includes(k)) ||
      required.some(k => !(input as any)[k]) || new Set(input.parcelIds).size !== input.parcelIds.length) throw orderError("Invalid custody intent", 400);
  input.parcelIds.sort();
  if (new Date(input.expectedUpdatedAt).toISOString() !== input.expectedUpdatedAt) throw orderError("Exact expected timestamp required", 400);
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  let a = await requireCustodyActor(actor, custodyPermission(input.action));
  return prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
    async function authorize() {
      const source = await loadCustodySource(tx, a, orderId);
      const receipt = await tx.orderCustodyAction.findUnique({ where: { tenantId_operationId: { tenantId: a.tenantId!, operationId: input.operationId } } });
      if (receipt) {
        if (receipt.orderId !== orderId || receipt.intentHash !== hash) deny("Custody operation identity conflict");
        await authorizeCustodyRetry(tx, a, receipt);
      } else await authorizeCustodyAction(tx, a, source, input.action);
      return { source, receipt };
    }
    await authorize();
    const locked = await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM "Order" WHERE id=${orderId}::uuid
      AND "tenantId"=${a.tenantId}::uuid AND "ownerOrgId"=${a.companyId}::uuid FOR UPDATE`;
    if (locked.length !== 1) throw orderError("Owned custody order required", 403);
    a = await requireCustodyActor(actor, custodyPermission(input.action));
    const { source, receipt: retry } = await authorize();
    const authority = { actor: a };
    const order = await tx.order.findFirst({ where: ownedCustodyWhere(a, orderId), include: { parcels: { select: { id: true }, take: 101 }, cashCollections: { select: { kind: true, status: true, expectedAmount: true } } } });
    if (!order || order.ownerOrgId !== a.companyId || order.assignedOrgId && order.assignedOrgId !== a.companyId) throw orderError("Selected owning operating company required", 403);
    if (input.warehouseId) await warehouse(tx, authority, input.warehouseId, true);
    if (input.destinationWarehouseId) await warehouse(tx, authority, input.destinationWarehouseId, false);
    if (retry) return retry.result;
    if (order.parcels.length > 100 || order.parcels.map(p => p.id).sort().join() !== input.parcelIds.join()) deny("Expected entire owned parcel set required");
    const previous = source.latest;
    if ((previous?.id ?? null) !== input.expectedEventId || order.updatedAt.toISOString() !== input.expectedUpdatedAt) deny("Stale custody/order state");
    const outgoing = ["intake", "receive"].includes(input.action) ? await observeOutgoingCustody(tx, a, source, input.outgoingDriverReason) : null;
    let phase = previous?.phase ?? "", warehouseId = previous?.warehouseId ?? null, destinationWarehouseId = previous?.destinationWarehouseId ?? null;
    let driverUserId = previous?.driverUserId ?? null, driverMembershipId = previous?.driverMembershipId ?? null, legId = previous?.legId ?? null;
    const change: Prisma.OrderUncheckedUpdateInput = { updatedAt: nextDispatchTime(order.updatedAt) };
    switch (input.action) {
      case "pickup-offer": {
        if (previous || order.status !== "picked_up" || order.currentWarehouseId || order.assignedDriverId !== a.id) deny("Fresh picked-up assignment required; no historical custody adoption");
        await driver(tx, a, a.companyMembershipId!, "local", custodyPermission("pickup-offer"));
        const source = await tx.tracking.findFirst({ where: { id: input.pickupTrackingId!, orderId, actorId: a.id, status: "picked_up" }, select: { id: true } });
        const last = await tx.tracking.findFirst({ where: { orderId, status: { not: null } }, orderBy: [{ timestamp: "desc" }, { id: "desc" }], select: { id: true } });
        if (!source || last?.id !== source.id) deny("Current pickup handover source required");
        phase = "pickup-offered"; destinationWarehouseId = input.destinationWarehouseId!; driverUserId = a.id; driverMembershipId = a.companyMembershipId!; break;
      }
      case "intake":
        if (phase !== "pickup-offered" || input.warehouseId !== destinationWarehouseId || order.status !== "picked_up" || order.assignedDriverId !== driverUserId) deny("Expected pickup offer required");
        phase = "warehouse"; warehouseId = input.warehouseId!; destinationWarehouseId = null; driverUserId = null; driverMembershipId = null;
        change.status = "at_warehouse"; change.currentWarehouseId = warehouseId; change.assignedDriverId = null; break;
      case "dispatch": {
        if (phase !== "warehouse" || input.warehouseId !== warehouseId || order.currentWarehouseId !== warehouseId || order.status !== "at_warehouse" || input.destinationWarehouseId === warehouseId) deny("Origin warehouse custody required");
        const leg = await tx.orderLeg.findFirst({ where: { id: input.legId!, orderId, status: "planned", fromWarehouseId: warehouseId, toWarehouseId: input.destinationWarehouseId!, carrierProviderId: null, carrierBookingStatus: "not_requested" }, select: { id: true } });
        if (!leg) deny("Unexecuted owned planned transport leg required");
        const d = await driver(tx, a, input.driverMembershipId!, "linehaul", custodyPermission("transport-accept"));
        phase = "transport-offered"; destinationWarehouseId = input.destinationWarehouseId!; driverUserId = d.userId; driverMembershipId = d.id; legId = leg.id; break;
      }
      case "transport-accept":
        if (phase !== "transport-offered" || driverUserId !== a.id || driverMembershipId !== a.companyMembershipId || order.status !== "at_warehouse" || order.currentWarehouseId !== warehouseId) deny("Exact transport acceptance required");
        await driver(tx, a, driverMembershipId!, "linehaul", custodyPermission("transport-accept"));
        if ((await tx.orderLeg.updateMany({ where: { id: legId!, orderId, status: "planned", fromWarehouseId: warehouseId, toWarehouseId: destinationWarehouseId, carrierProviderId: null, carrierBookingStatus: "not_requested" }, data: { status: "departed", actualDepartureAt: new Date() } })).count !== 1) deny("Transport leg changed");
        phase = "transport"; change.status = "in_transit"; change.currentWarehouseId = null; change.assignedDriverId = null; break;
      case "receive":
        if (phase !== "transport" || input.warehouseId !== destinationWarehouseId || order.status !== "in_transit" || order.currentWarehouseId) deny("Accepted transport and expected destination required");
        if ((await tx.orderLeg.updateMany({ where: { id: legId!, orderId, status: { in: ["departed", "in_transit", "arrived"] }, fromWarehouseId: warehouseId, toWarehouseId: destinationWarehouseId, carrierProviderId: null, carrierBookingStatus: "not_requested" }, data: { status: "completed", actualArrivalAt: new Date() } })).count !== 1) deny("Expected owned leg required");
        warehouseId = input.warehouseId!; destinationWarehouseId = null; driverUserId = null; driverMembershipId = null;
        phase = "warehouse"; change.status = "at_warehouse"; change.currentWarehouseId = warehouseId; change.assignedDriverId = null; break;
      case "last-mile-offer": {
        if (phase !== "warehouse" || input.warehouseId !== warehouseId || order.currentWarehouseId !== warehouseId || order.status !== "at_warehouse") deny("Destination custody required");
        const d = await driver(tx, a, input.driverMembershipId!, "local", custodyPermission("last-mile-accept"));
        phase = "last-mile-offered"; driverUserId = d.userId; driverMembershipId = d.id; change.assignedDriverId = d.userId; break;
      }
      case "last-mile-accept":
        if (phase !== "last-mile-offered" || driverUserId !== a.id || driverMembershipId !== a.companyMembershipId || order.assignedDriverId !== a.id || order.currentWarehouseId !== warehouseId || order.status !== "at_warehouse") deny("Exact assigned last-mile acceptance required");
        await driver(tx, a, driverMembershipId!, "local", custodyPermission("last-mile-accept"));
        phase = "last-mile"; change.status = "out_for_delivery"; change.currentWarehouseId = null; break;
      case "deliver": {
        if (phase !== "last-mile" || driverUserId !== a.id || driverMembershipId !== a.companyMembershipId || order.assignedDriverId !== a.id || order.status !== "out_for_delivery") deny("Accepted assigned last-mile custody required");
        await driver(tx, a, driverMembershipId!, "local", custodyPermission("deliver"));
        const proof = await tx.$queryRaw<any[]>`SELECT "submissionId" FROM "ProofSubmission" WHERE "submissionId"=${input.proofSubmissionId!}
          AND "orderId"=${orderId}::uuid AND "tenantId"=${a.tenantId!}::uuid AND "companyId"=${a.companyId!}::uuid
          AND "userId"=${a.id}::uuid AND "companyMembershipId"=${a.companyMembershipId!}::uuid AND "tenantMembershipId"=${a.tenantMembershipId!}::uuid
          AND stage='delivery' AND state='confirmed' AND "createdAt">${previous!.createdAt}`;
        if (proof.length !== 1) deny("Current confirmed delivery proof required");
        assertDeliveryCashSettled(order);
        phase = "delivered"; change.status = "delivered"; break;
      }
    }
    await tx.order.update({ where: { id: orderId }, data: change });
    const tracking = await tx.tracking.create({ data: { orderId, actorId: a.id, actorRole: null, status: (change.status ?? order.status) as OrderStatus,
      warehouseId: change.currentWarehouseId === null ? null : warehouseId, orderLegId: legId ?? null, timestamp: new Date(), note: `Custody: ${input.action}` } });
    const id = randomUUID(), result = { eventId: id, orderId, operationId: input.operationId, phase, status: change.status ?? order.status,
      currentWarehouseId: change.currentWarehouseId === undefined ? order.currentWarehouseId : change.currentWarehouseId, trackingId: tracking.id };
    // Transaction-start now() can precede time spent waiting for the order lock.
    const clock=await tx.$queryRaw<Array<{at:Date}>>`SELECT clock_timestamp() AS at`;
    await tx.orderCustodyAction.create({ data: { id, tenantId: a.tenantId!, companyId: a.companyId!, orderId, operationId: input.operationId,
      createdAt:clock[0].at,
      sequence: (previous?.sequence ?? 0) + 1, action: input.action, phase, actorUserId: a.id, companyMembershipId: a.companyMembershipId!, tenantMembershipId: a.tenantMembershipId!,
      intentHash: hash, intent:input, previousEventId: previous?.id, warehouseId, destinationWarehouseId, driverUserId, driverMembershipId, legId, trackingId: tracking.id,
      beforeState: { eventId: previous?.id ?? null, phase: previous?.phase ?? null, status: order.status, warehouseId: order.currentWarehouseId, driverId: previous?.driverUserId ?? order.assignedDriverId, outgoing }, result: result as Prisma.InputJsonValue } });
    await tx.orderCustodyParcel.createMany({data:input.parcelIds.map(parcelId=>({actionId:id,parcelId,orderId}))});
    await persistDispatchNotification(tx, tracking.id, "status");
    await enqueueCargoPilotDomainEventsTx(tx, [{ type: "order_status_changed", tenantScope: `tenant:${a.tenantId}:company:${a.companyId}`, entityId: orderId,
      payload: { source: "warehouse_custody", custodyEventId: id, action: input.action } }]);
    // The append-only action is both normalized receipt and operational security audit.
    return result;
  }, { maxWait: 2000, timeout: 10000 });
}

export async function readWarehouseCustody(actor: OrderActor, orderId: string) {
  const parsed=uuid.safeParse(orderId);
  if(!parsed.success) throw orderError("Valid order identifier required",400);
  orderId=parsed.data;
  const a = await requireCustodyActor(actor, "shipment.view");
  const source = await loadCustodySource(prisma, a, orderId);
  await authorizeCustodyRead(prisma, a, source);
  const parcels = await prisma.parcel.findMany({ where: { orderId }, select: { id: true }, orderBy: { id: "asc" }, take: 101 });
  if (parcels.length > 100) throw orderError("Custody parcel limit exceeded", 409);
  const latest = source.latest;
  const custody = latest ? { id: latest.id, phase: latest.phase, warehouseId: latest.warehouseId,
    destinationWarehouseId: latest.destinationWarehouseId, driverUserId: latest.driverUserId, legId: latest.legId, createdAt: latest.createdAt } : null;
  const pickup = !latest && source.order.status === "picked_up" ? await prisma.tracking.findFirst({ where: { orderId, status: { not: null } },
    orderBy: [{ timestamp: "desc" }, { id: "desc" }], select: { id: true, status: true, actorId: true } }) : null;
  return { orderId, updatedAt: source.order.updatedAt.toISOString(), custody, parcelIds: parcels.map(p => p.id),
    pickupTrackingId: pickup?.status === "picked_up" && pickup.actorId === a.id ? pickup.id : null };
}
