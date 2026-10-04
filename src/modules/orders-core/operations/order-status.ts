import { requireInitialPickupAuthority } from "../domain/custody-access";
import prisma from "../../../config/prismaClient";
import { persistDispatchNotification, withDispatchNotifications } from "../domain/dispatch-notification";
import { enqueueCargoPilotDomainEventsTx } from "../../analytics-core/infrastructure/analyticsOutbox";
import {
  CashCollectionKind,
  CashCollectionStatus,
  OrderStatus,
  PaidBy,
  PaidStatus,
  Prisma,
  ReasonCode,
  WarehouseType,
} from "@prisma/client";
import { OrderActor, orderError } from "../shared";

import { requireDispatchAuthority, dispatchOrderWhere, type DispatchAuthority } from "../domain/dispatch-authority";

import { parseDispatchBatch, requireExpectedDispatchState, lockDispatchBatch, nextDispatchTime, withDispatchChanges, dispatchTransactionOptions } from "../domain/dispatch-batch";

const dispatchStateSelect = {
        id: true, updatedAt: true,
        status: true,
        lastExceptionReason: true,
        assignedDriverId: true,
        currentWarehouseId: true,
        codAmount: true,
        codPaidStatus: true,
        serviceCharge: true,
        serviceChargePaidStatus: true,
        deliveryChargePaidBy: true,
        cashCollections: {
          select: {
            kind: true,
            status: true,
            expectedAmount: true,
          },
        },
      } as const;

type DispatchRow = Prisma.OrderGetPayload<{select:typeof dispatchStateSelect}>;
function assertDriverStatusTransition(actor:OrderActor,order:DispatchRow,status:OrderStatus,reasonCode?:ReasonCode|null) {
    if (status === OrderStatus.delivered || status === OrderStatus.out_for_delivery) {
      throw orderError("Durable warehouse custody endpoint required for delivery", 409);
    }
    if (order.assignedDriverId !== actor.id) {
      throw orderError("You are not assigned to this order; manual transition policy is unavailable", 403);
    }
    if (FINAL_ORDER_STATUSES.includes(order.status)) {
      throw orderError("Order is already in final state", 400);
    }

    const allowedNext = getDriverAllowedTransitionsForOrder(order);
    if (!allowedNext.includes(status)) {
      const currentStage = formatStatus(order.status);
      const targetStage = formatStatus(status);
      const allowedStages = allowedNext.map(formatStatus).join(", ");
      throw orderError(
        `Driver cannot move order from ${currentStage} to ${targetStage}. Allowed next stages: ${allowedStages || "none"}.`,
        400,
      );
    }

    if (REASON_REQUIRED_STATUSES.has(status) && !reasonCode) {
      throw orderError(`reasonCode is required when status is ${status}`, 400);
    }

    const { hasPickupCashDue } = hasCashDueForStage(order);

    if (status === OrderStatus.picked_up && hasPickupCashDue) {
      throw orderError(
        "Cannot complete pickup while sender-side service charge is still expected. Collect cash first.",
        400,
      );
    }


}

type AssignmentType = "pickup" | "delivery" | "linehaul";

const FINAL_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.delivered,
  OrderStatus.returned,
  OrderStatus.cancelled,
];

const WAREHOUSE_ALLOWED_MANUAL_STATUSES: Record<WarehouseType, Set<OrderStatus>> =
  {
    [WarehouseType.warehouse]: new Set<OrderStatus>([
      OrderStatus.at_warehouse,
      OrderStatus.in_transit,
      OrderStatus.out_for_delivery,
      OrderStatus.exception,
    ]),
    [WarehouseType.pickup_point]: new Set<OrderStatus>([
      OrderStatus.at_warehouse,
      OrderStatus.in_transit,
      OrderStatus.out_for_delivery,
      OrderStatus.delivered,
      OrderStatus.exception,
      OrderStatus.return_in_progress,
    ]),
  };

const ASSIGNABLE_ORDER_STATUSES: Record<AssignmentType, OrderStatus[]> = {
  pickup: [OrderStatus.pending, OrderStatus.assigned, OrderStatus.exception],
  delivery: [
    OrderStatus.at_warehouse,
    OrderStatus.out_for_delivery,
    OrderStatus.exception,
  ],
  linehaul: [
    OrderStatus.at_warehouse,
    OrderStatus.in_transit,
    OrderStatus.exception,
  ],
};

const REASON_REQUIRED_STATUSES = new Set<OrderStatus>([
  OrderStatus.exception,
  OrderStatus.return_in_progress,
  OrderStatus.cancelled,
]);

const PICKUP_REASON_CODES = new Set<ReasonCode>([
  ReasonCode.BAD_SENDER_ADDRESS,
  ReasonCode.SENDER_NOT_AVAILABLE,
  ReasonCode.SENDER_MOBILE_OFF,
  ReasonCode.SENDER_MOBILE_WRONG,
  ReasonCode.SENDER_MOBILE_NO_RESPONSE,
  ReasonCode.OUT_OF_PICKUP_AREA,
  ReasonCode.UNABLE_TO_ACCESS_SENDER_PREMISES,
  ReasonCode.NO_CAPACITY_PICKUP,
  ReasonCode.PROHIBITED_ITEMS,
  ReasonCode.INCORRECT_PACKING,
  ReasonCode.NO_AWB_PRINTED,
  ReasonCode.PICKUP_DELAY_LATE_BOOKING,
  ReasonCode.BAD_WEATHER_PICKUP,
  ReasonCode.SENDER_NAME_MISSING,
  ReasonCode.DOCUMENTS_MISSING,
]);

const DRIVER_ALLOWED_TRANSITIONS: Partial<Record<OrderStatus, OrderStatus[]>> =
  {
    [OrderStatus.assigned]: [OrderStatus.pickup_in_progress],
    [OrderStatus.pickup_in_progress]: [
      OrderStatus.picked_up,
      OrderStatus.exception,
    ],
    [OrderStatus.at_warehouse]: [OrderStatus.out_for_delivery],
    [OrderStatus.out_for_delivery]: [
      OrderStatus.delivered,
      OrderStatus.exception,
      OrderStatus.return_in_progress,
    ],
    [OrderStatus.exception]: [
      OrderStatus.pickup_in_progress,
      OrderStatus.out_for_delivery,
      OrderStatus.return_in_progress,
    ],
  };

function isPickupReason(reasonCode?: ReasonCode | null) {
  return !!reasonCode && PICKUP_REASON_CODES.has(reasonCode);
}

function getDriverAllowedTransitionsForOrder(order: {
  status: OrderStatus;
  lastExceptionReason?: ReasonCode | null;
}) {
  if (order.status !== OrderStatus.exception) {
    return DRIVER_ALLOWED_TRANSITIONS[order.status] ?? [];
  }

  if (isPickupReason(order.lastExceptionReason)) {
    return [OrderStatus.pickup_in_progress];
  }

  return [OrderStatus.out_for_delivery, OrderStatus.return_in_progress];
}

function normalizeAssignmentType(input: unknown): AssignmentType {
  if (input === "pickup" || input === "delivery" || input === "linehaul") {
    return input;
  }
  if (input == null) return "pickup";
  throw orderError("Invalid assignment type", 400);
}

async function resolveActorWarehouseType(
  actor: OrderActor,
  db: Prisma.TransactionClient = prisma,
): Promise<WarehouseType | null> {
  if (!actor.warehouseId) return null;
  if (!actor.warehouseId) {
    throw orderError("Warehouse user has no warehouse assigned", 403);
  }
  const warehouse = await db.warehouse.findFirst({
    where: { id: actor.warehouseId, tenantId: actor.tenantId ?? "__no_access__" },
    select: { type: true, tenantId: true },
  });
  if (!warehouse || !actor.tenantId || warehouse.tenantId !== actor.tenantId) {
    throw orderError("Attached warehouse not found", 403);
  }
  return warehouse.type;
}

function assertWarehouseScope(
  actor: OrderActor,
  orders: Array<{ id: string; currentWarehouseId: string | null }>,
) {
  if (!actor.warehouseId) return;
  if (!actor.warehouseId) {
    throw orderError("Warehouse user has no warehouse assigned", 403);
  }
  const wrong = orders.filter(
    (o) => o.currentWarehouseId && o.currentWarehouseId !== actor.warehouseId,
  );
  if (wrong.length) {
    throw orderError(
      `Orders not in your warehouse: ${wrong.map((x) => x.id).join(", ")}`,
      403,
    );
  }
}

function resolveWarehouseId(actor: OrderActor, provided?: string | null) {
  if (actor.warehouseId) return actor.warehouseId;
  return provided ?? null;
}

async function requireWarehouseReference(actor: OrderActor, warehouseId: string | null, db: Prisma.TransactionClient = prisma) {
  if (!warehouseId) return;
  if (!actor.tenantId) throw orderError("Tenant context required", 403);

  const allowedWarehouseIds = new Set(
    (actor.scopes ?? [])
      .filter((scope) => scope.scopeType === "warehouse")
      .map((scope) => scope.scopeRefId),
  );
  if (actor.warehouseId) allowedWarehouseIds.add(actor.warehouseId);
  if (!allowedWarehouseIds.has(warehouseId)) {
    throw orderError("Warehouse is outside the selected membership scope", 403);
  }

  const warehouse = await db.warehouse.findFirst({
    where: { id: warehouseId, tenantId: actor.tenantId },
    select: { id: true },
  });
  if (!warehouse) throw orderError("Warehouse is outside the selected tenant", 403);
}

function formatStatus(status: OrderStatus) {
  return status.replace(/_/g, " ");
}

function resolveActorTenantScope(actor: OrderActor) {
  if (!actor.tenantId || !actor.companyId) {
    throw orderError("Tenant-bound company context required", 403);
  }
  return `tenant:${actor.tenantId}:company:${actor.companyId}`;
}

function hasPositiveAmount(value: unknown) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) && amount > 0;
}

function normalizeActorRoleForTracking(): null {
  return null;
}

function isPendingPaidStatus(value: PaidStatus | null | undefined) {
  return value !== PaidStatus.PAID;
}

function hasCashDueForStage(order: {
  codAmount: number | null;
  codPaidStatus: PaidStatus | null;
  serviceCharge: number | null;
  serviceChargePaidStatus: PaidStatus | null;
  deliveryChargePaidBy: PaidBy | null;
  cashCollections?: Array<{
    kind: CashCollectionKind;
    status: CashCollectionStatus;
    expectedAmount: number | null;
  }>;
}) {
  const collectionRows = Array.isArray(order.cashCollections)
    ? order.cashCollections
    : [];

  const pendingCollections = collectionRows.filter(
    (collection) =>
      collection.status === CashCollectionStatus.expected &&
      hasPositiveAmount(collection.expectedAmount),
  );

  const hasPendingCodCollection = pendingCollections.some(
    (collection) => collection.kind === CashCollectionKind.cod,
  );
  const hasPendingServiceChargeCollection = pendingCollections.some(
    (collection) => collection.kind === CashCollectionKind.service_charge,
  );

  const hasCodCollectionRow = collectionRows.some(
    (collection) => collection.kind === CashCollectionKind.cod,
  );
  const hasServiceChargeCollectionRow = collectionRows.some(
    (collection) => collection.kind === CashCollectionKind.service_charge,
  );

  const fallbackCodPending =
    !hasCodCollectionRow &&
    hasPositiveAmount(order.codAmount) &&
    isPendingPaidStatus(order.codPaidStatus);
  const fallbackServiceChargePending =
    !hasServiceChargeCollectionRow &&
    hasPositiveAmount(order.serviceCharge) &&
    isPendingPaidStatus(order.serviceChargePaidStatus);

  const hasPickupCashDue =
    (hasPendingServiceChargeCollection || fallbackServiceChargePending) &&
    order.deliveryChargePaidBy === PaidBy.SENDER;

  const hasDeliveryCashDue =
    hasPendingCodCollection ||
    fallbackCodPending ||
    ((hasPendingServiceChargeCollection || fallbackServiceChargePending) &&
      (order.deliveryChargePaidBy === PaidBy.RECIPIENT ||
        order.deliveryChargePaidBy == null));

  return { hasPickupCashDue, hasDeliveryCashDue };
}

export function assertDeliveryCashSettled(order: Parameters<typeof hasCashDueForStage>[0]) {
  if (hasCashDueForStage(order).hasDeliveryCashDue) throw orderError("Cannot complete delivery while COD/service charge is still expected. Collect cash first.", 400);
}

async function loadAssignedOrdersForResponse(
  orderIds: string[],
  authority: DispatchAuthority,
  _includeFull?: boolean,
  db: Prisma.TransactionClient = prisma,
) {
  // Full mutation expansion is contained; use authorized detail endpoints.
  return db.order.findMany({
    where: dispatchOrderWhere(authority, orderIds),
    select: {
      id: true,
      orderNumber: true,
      status: true,
      assignedDriverId: true,
      currentWarehouseId: true,
      updatedAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function assignDriversBulk(args: {
  orderIds: string[]; expectedStates?: unknown; driverId: string; type?: AssignmentType | string;
  warehouseId?: string | null; note?: string | null; region?: string | null; actor: OrderActor; includeFull?: boolean;
}) {
  let authority = await requireDispatchAuthority(args.actor, "shipment.assignCourier");
  let { actor } = authority;
  const { orderIds, expected } = parseDispatchBatch(args.orderIds, args.expectedStates);
  const type = normalizeAssignmentType(args.type), driverId = args.driverId;
  if (!driverId) throw orderError("Missing driverId", 400);
  return prisma.$transaction(async tx => {
    await lockDispatchBatch(tx, authority, orderIds);
    authority = await requireDispatchAuthority(actor,"shipment.assignCourier");
    actor = authority.actor;
    const orders = await tx.order.findMany({ where: dispatchOrderWhere(authority, orderIds), select: {
      id: true, status: true, assignedDriverId: true, currentWarehouseId: true, updatedAt: true,
    } });
    if (orders.length !== orderIds.length) throw orderError("Some orders are no longer in scope", 409);
    requireExpectedDispatchState(orders, expected); assertWarehouseScope(actor, orders);
    if (await tx.orderCustodyAction.count({where:{orderId:{in:orderIds}}})) throw orderError("Custody-bound assignments require the warehouse custody endpoint",409);
    if (args.warehouseId || actor.warehouseId) throw orderError("Assignment cannot establish warehouse custody",409);
    if (orders.some(order => FINAL_ORDER_STATUSES.includes(order.status) || !ASSIGNABLE_ORDER_STATUSES[type].includes(order.status)))
      throw orderError("Assignment is not permitted at the current stage", 409);
    const driver = await tx.user.findUnique({where:{id:driverId},select:{id:true,driverType:true}});
    const membership = await tx.companyMembership.findFirst({ where: {
      userId: driverId, tenantId: actor.tenantId, companyId: actor.companyId!, status: "active", tenant: {status:"active"},
      tenantMembership: {userId:driverId,tenantId:actor.tenantId!,status:"active"},
      company:{id:actor.companyId!,tenantId:actor.tenantId!,isActive:true},
    }, select:{id:true,roles:{select:{role:{select:{companyId:true,isSystem:true,rolePermissions:{select:{permission:{select:{key:true}}}}}}}}} });
    if (!driver?.driverType || !membership || !membership.roles.some(({role}) =>
      (role.companyId === actor.companyId || (role.companyId === null && role.isSystem)) &&
      role.rolePermissions.some(({permission}) => permission.key === "drivers.telemetry"))) throw orderError("Driver is outside the selected company context",403);
    if (actor.warehouseId && args.warehouseId && actor.warehouseId !== args.warehouseId) throw orderError("Conflicting warehouse selection",403);
    const warehouseId = resolveWarehouseId(actor,args.warehouseId);
    await requireWarehouseReference(actor,warehouseId,tx);
    const changed: string[] = [];
    const notificationIds: string[] = [];
    for (const order of orders) {
      const status = type === "pickup" ? OrderStatus.assigned : order.status;
      if (order.assignedDriverId === driverId && order.status === status) continue;
      const result = await tx.order.updateMany({where:{AND:[dispatchOrderWhere(authority,[order.id]),{status:order.status,assignedDriverId:order.assignedDriverId,updatedAt:order.updatedAt}]},
        data:{assignedDriverId:driverId,status,updatedAt:nextDispatchTime(order.updatedAt)}});
      if (result.count !== 1) throw orderError("Order is no longer in scope",409);
      changed.push(order.id);
      const tracking = await tx.tracking.create({data:{orderId:order.id,status:type === "pickup" ? status : null,reasonCode:null,
        note:args.note ?? `Driver assigned (${type}) to ${driverId}`,region:args.region ?? null,warehouseId,
        actorId:actor.id,actorRole:null,parcelId:null}});
      const notificationId = await persistDispatchNotification(tx, tracking.id, "assignment");
      if (notificationId) notificationIds.push(notificationId);
    }
    if (changed.length) await enqueueCargoPilotDomainEventsTx(tx,changed.map(id=>({type:type === "pickup" ? "order_status_changed" : "manual_refresh",
      tenantScope:resolveActorTenantScope(actor),entityId:id,payload:{source:"assignDriversBulk",assignmentType:type,driverId,actorId:actor.id,actorRole:null}})));
    return withDispatchNotifications(withDispatchChanges(await loadAssignedOrdersForResponse(orderIds,authority,args.includeFull,tx),changed), notificationIds);
  },dispatchTransactionOptions);
}

export async function assignOrderTasksBulk(args: {
  orderIds: string[];
  expectedStates?: unknown;
  driverId: string;
  type?: AssignmentType | string;
  warehouseId?: string | null;
  note?: string | null;
  region?: string | null;
  actor: OrderActor;
  includeFull?: boolean;
}) {
  return assignDriversBulk(args);
}

export async function updateOrdersStatusBulk(args: {
  orderIds: string[]; expectedStates?: unknown; status: OrderStatus; reasonCode?: ReasonCode | null;
  warehouseId?: string | null; note?: string | null; region?: string | null; actor: OrderActor; includeFull?: boolean;
}) {
  let authority = await requireDispatchAuthority(args.actor,"shipment.changeStatus");
  let {actor} = authority;
  const {orderIds,expected} = parseDispatchBatch(args.orderIds,args.expectedStates);
  return prisma.$transaction(async tx => {
    await lockDispatchBatch(tx,authority,orderIds);
    authority = await requireDispatchAuthority(actor,"shipment.changeStatus");
    actor = authority.actor;
    const orders = await tx.order.findMany({where:dispatchOrderWhere(authority,orderIds),select:dispatchStateSelect});
    if (orders.length !== orderIds.length) throw orderError("Some orders are no longer in scope",409);
    requireExpectedDispatchState(orders,expected); assertWarehouseScope(actor,orders);
    await requireWarehouseReference(actor,args.warehouseId ?? null,tx);
    const warehouseType = await resolveActorWarehouseType(actor,tx);
    if (warehouseType && !WAREHOUSE_ALLOWED_MANUAL_STATUSES[warehouseType].has(args.status)) throw orderError("Warehouse target status forbidden",403);
    // The warehouse target allowlist does not establish a manual transition matrix.
    const notificationIds: string[] = [];
    for (const order of orders) {
      assertDriverStatusTransition(actor,order,args.status,args.reasonCode);
      if (args.warehouseId && args.warehouseId !== order.currentWarehouseId) throw orderError("Warehouse does not belong to current order state",403);
    }
    for (const order of orders) {
      const result = await tx.order.updateMany({where:{AND:[dispatchOrderWhere(authority,[order.id]),{status:order.status,assignedDriverId:actor.id,updatedAt:order.updatedAt}]},
        data:{status:args.status,updatedAt:nextDispatchTime(order.updatedAt),...(args.status === OrderStatus.exception ? {lastExceptionReason:args.reasonCode ?? null,lastExceptionAt:new Date()} : {})}});
      if (result.count !== 1) throw orderError("Order is no longer in scope",409);
      const tracking = await tx.tracking.create({data:{orderId:order.id,status:args.status,reasonCode:args.reasonCode ?? null,note:args.note ?? null,region:args.region ?? null,
        warehouseId:order.currentWarehouseId,actorId:actor.id,actorRole:null,parcelId:null}});
      const notificationId = await persistDispatchNotification(tx, tracking.id, "status");
      if (notificationId) notificationIds.push(notificationId);
    }
    await enqueueCargoPilotDomainEventsTx(tx,orders.map(order=>({type:"order_status_changed",tenantScope:resolveActorTenantScope(actor),entityId:order.id,
      payload:{source:"updateOrdersStatusBulk",status:args.status,reasonCode:args.reasonCode ?? null,actorId:actor.id,actorRole:null}})));
    return withDispatchNotifications(withDispatchChanges(await loadAssignedOrdersForResponse(orderIds,authority,args.includeFull,tx),orderIds), notificationIds);
  },dispatchTransactionOptions);
}

export async function updateDriverOrderStatus(args: {
  orderId: string;
  status: OrderStatus;
  reasonCode?: ReasonCode | null;
  note?: string | null;
  region?: string | null;
  actor: OrderActor;
}) {
  const { orderId, status, reasonCode, note, region, actor: requestedActor } = args;
  // Only existing forward pickup transitions use the exact owned assignment alternative.
  const pickup = status === OrderStatus.pickup_in_progress || status === OrderStatus.picked_up;
  const resolve = (actor: OrderActor) => pickup ? requireInitialPickupAuthority(actor) : requireDispatchAuthority(actor, "shipment.changeStatus");
  let authority = await resolve(requestedActor);
  let { actor } = authority;

  if (!orderId) {
    throw orderError("orderId is required", 400);
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
    const stateQuery = {where:dispatchOrderWhere(authority,[orderId]),select:dispatchStateSelect} as const;
    const initial = await tx.order.findFirst(stateQuery);
    if (!initial) throw orderError("Order not found", 404);
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Order"
      WHERE "id" = ${orderId}::uuid AND "tenantId" = ${actor.tenantId}::uuid
        AND ("ownerOrgId" = ${actor.companyId}::uuid OR "assignedOrgId" = ${actor.companyId}::uuid) FOR UPDATE`;
    if (locked.length !== 1) throw orderError("Order is no longer in scope", 409);
    authority = await resolve(actor);
    actor = authority.actor;
    const order = await tx.order.findFirst({...stateQuery,where:dispatchOrderWhere(authority,[orderId])});
    if (!order) {
      throw orderError("Order not found", 404);
    }
    assertDriverStatusTransition(actor,order,status,reasonCode);

    const updateData: any = { status, updatedAt:nextDispatchTime(order.updatedAt) };
    if (status === OrderStatus.at_warehouse) {
      updateData.assignedDriverId = null;
    }
    if (status === OrderStatus.exception) {
      updateData.lastExceptionReason = reasonCode ?? null;
      updateData.lastExceptionAt = new Date();
    }

    const updated = await tx.order.updateMany({
      where: { AND: [dispatchOrderWhere(authority, [orderId]), { status: order.status, updatedAt: order.updatedAt, assignedDriverId: actor.id }] },
      data: updateData,
    });
    if (updated.count !== 1) {
      throw orderError("Order is no longer in scope", 409);
    }

    const tracking = await tx.tracking.create({
      data: {
        orderId,
        status,
        reasonCode: reasonCode ?? null,
        note: note ?? null,
        region: region ?? null,
        warehouseId: order.currentWarehouseId ?? null,
        actorId: actor.id,
        actorRole: normalizeActorRoleForTracking(),
        parcelId: null,
      },
    });

    const notificationId = await persistDispatchNotification(tx, tracking.id, "status");
    await enqueueCargoPilotDomainEventsTx(tx, [
      {
        type: "order_status_changed",
        tenantScope: resolveActorTenantScope(actor),
        entityId: orderId,
        payload: {
          source: "updateDriverOrderStatus",
          status,
          reasonCode: reasonCode ?? null,
          actorId: actor.id,
          actorRole: normalizeActorRoleForTracking(),
        },
      },
    ]);
    const response = await tx.order.findFirst({
    where: dispatchOrderWhere(authority, [orderId]),
    select: {
      id: true,
      orderNumber: true,
      status: true,
      assignedDriverId: true,
      currentWarehouseId: true,
      updatedAt: true,
    },
  });
    if (!response) throw orderError("Order response unavailable",409);
    return withDispatchNotifications(response, notificationId ? [notificationId] : []);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 2000, timeout: 10000 });
}
