import { validateCreationReferences } from "../domain/creation-references";
import type { AppUser } from "../../../types/app-user";
import { assertCreationInputAuthority, authorityError } from "../domain/creation-authority";
import { requireTenantBoundOrderCompanyAuthority, hasCompanyScope } from "../domain/company-authority";
import prisma from "../../../config/prismaClient";
import { OrderPaymentState, OrderStatus, Prisma } from "@prisma/client";

import { enqueueCargoPilotDomainEventsTx } from "../../analytics-core/infrastructure/analyticsOutbox";
import { resolveOrderSlaSnapshot } from "../sla";
import { CreateOrderRepoPayload } from "../domain/orderCreate.mapper";
import { OrderActor, orderError } from "../shared";
import { userLiteSelect } from "./order-repo.shared";
import { assertCreationRequest, assertCreationPayload, type CreationRequest } from "../domain/creation-request";

const creationAddressSelect = { id: true, tenantId: true, customerEntityId: true, country: true, city: true,
  neighborhood: true, street: true, latitude: true, longitude: true, addressLine1: true, addressLine2: true,
  building: true, apartment: true, floor: true, landmark: true, postalCode: true, addressType: true } satisfies Prisma.AddressSelect;
const orderCreationInclude = {
        customer: { select: userLiteSelect },
        customerEntity: { select: { id: true, name: true, type: true, companyName: true } },
        senderAddressObj: { select: creationAddressSelect },
        receiverAddressObj: { select: creationAddressSelect },
        attachments: true,
        parcels: true,
        cashCollections: {
          include: {
            currentHolderUser: { select: userLiteSelect },
            currentHolderWarehouse: true,
            events: {
              include: {
                actor: { select: userLiteSelect },
              },
              orderBy: { createdAt: "asc" },
            },
          },
        },
        currentWarehouse: true,
        assignedDriver: { select: userLiteSelect },
        invoice: true,
        trackingEvents: {
          include: {
            actor: { select: userLiteSelect },
            warehouse: true,
            parcel: true,
          },
          orderBy: { timestamp: "asc" },
        },
      } satisfies Prisma.OrderInclude;


function sanitizeSnapshot(s: any) {
  if (!s || typeof s !== "object") return null;

  return {
    country: s.country ?? null,
    city: s.city ?? null,
    neighborhood: s.neighborhood ?? null,
    street: s.street ?? null,
    latitude:
      typeof s.latitude === "number" && Number.isFinite(s.latitude)
        ? s.latitude
        : null,
    longitude:
      typeof s.longitude === "number" && Number.isFinite(s.longitude)
        ? s.longitude
        : null,
    addressLine1: s.addressLine1 ?? null,
    addressLine2: s.addressLine2 ?? null,
    building: s.building ?? null,
    apartment: s.apartment ?? null,
    floor: s.floor ?? null,
    landmark: s.landmark ?? null,
    postalCode: s.postalCode ?? null,
    addressType: s.addressType ?? null,
    // keep passport fields out unless you really want them
  };
}

function toDateOrNull(v?: Date | string | null) {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeActorRoleForTracking(): null {
  return null;
}

async function getNextOrderNumberTx(tx: Prisma.TransactionClient): Promise<string> {
  const counter = await tx.counter.upsert({
    where: { key: "orderNumber" },
    update: { value: { increment: 1 } },
    create: { key: "orderNumber", value: 1 },
  });
  return `99${String(counter.value).padStart(10, "0")}`;
}

/** Persists a new order with related parcels and initial tracking event. */
export const createOrder = async (
  customerId: string,
  payload: CreateOrderRepoPayload,
  actor: OrderActor,
  request: CreationRequest | undefined,
  ordinal = 0,
) => {
  assertCreationInputAuthority({
    customerEntityId: payload.customerEntityId,
    senderAddressId: payload.senderAddressId, receiverAddressId: payload.receiverAddressId,
    savePickupToAddressBook: payload.savePickupToAddressBook,
    saveDropoffToAddressBook: payload.saveDropoffToAddressBook,
  });
  if ((payload.codPaidStatus != null && payload.codPaidStatus !== "NOT_PAID") ||
      (payload.serviceChargePaidStatus != null && payload.serviceChargePaidStatus !== "NOT_PAID") ||
      payload.amount != null) throw authorityError("Client financial authority is not accepted");
  if (actor?.id !== customerId) throw authorityError("Order creator must be the authenticated identity", 403);
  if (!request) throw authorityError("Durable creation request required");
  assertCreationPayload(actor,request,ordinal,payload);
  return creationTransaction(async (tx) => {
    await lockCreation(tx, request);
    const membership = await creationAuthority(tx,actor);
    const references = await validateCreationReferences(tx, actor as AppUser, payload, true);
    const intent = await resolveIntent(tx,actor,request,request.kind==="order");
    if(!intent) throw authorityError("Accepted import intent required",409);
    const existing = await readReceipt(tx,actor,request,intent.id,ordinal);
    if(existing) return {order:existing,replayed:true};
    const senderAddressId = references.senderAddressId ?? null;
    const receiverAddressId = references.receiverAddressId ?? null;
    const createdAt = new Date();
    const orderNumber = await getNextOrderNumberTx(tx);
    const slaSnapshot = await resolveOrderSlaSnapshot({
      serviceType: payload.serviceType ?? null,
      originQuery:
        payload.senderAddressSnapshot?.city ?? null,
      destinationQuery:
        payload.destinationCity ??
        payload.receiverAddressSnapshot?.city ??
        null,
      promiseDate: payload.promiseDate ?? null,
      createdAt,
    });

    const pieceTotal =
      payload.pieceTotal ??
      (payload.parcels?.length ? payload.parcels.length : 1);

    const parcelsToCreate = payload.parcels?.length
      ? payload.parcels.map((p, idx) => ({
          pieceNo: idx + 1,
          pieceTotal,
          weightKg: p.weightKg ?? null,
          lengthCm: p.lengthCm ?? null,
          widthCm: p.widthCm ?? null,
          heightCm: p.heightCm ?? null,
          parcelCode: `${orderNumber}-${idx + 1}/${pieceTotal}`,
        }))
      : [
          {
            pieceNo: 1,
            pieceTotal,
            parcelCode: `${orderNumber}-1/${pieceTotal}`,
          },
        ];

    // DOM-06: creation quotes/COD requests are not accepted cash obligations.
    const created = await tx.order.create({
      data: {
        tenantId: membership.tenantId,
        customerId,
        orderNumber,
        status: OrderStatus.pending,
        pickupAddress: payload.pickupAddress,
        dropoffAddress: payload.dropoffAddress,
        destinationCity: payload.destinationCity ?? null,
        pickupLat: payload.pickupLat ?? null,
        pickupLng: payload.pickupLng ?? null,
        dropoffLat: payload.dropoffLat ?? null,
        dropoffLng: payload.dropoffLng ?? null,
        senderName: payload.senderName ?? null,
        senderPhone: payload.senderPhone ?? null,
        senderPhone2: payload.senderPhone2 ?? null,
        senderPhone3: payload.senderPhone3 ?? null,
        senderAddress: payload.senderAddress ?? null,
        receiverName: payload.receiverName ?? null,
        receiverPhone: payload.receiverPhone ?? null,
        receiverPhone2: payload.receiverPhone2 ?? null,
        receiverPhone3: payload.receiverPhone3 ?? null,
        receiverAddress: payload.receiverAddress ?? null,
        ownerOrgId: membership.companyId,
        customerEntityId: references.customerEntityId ?? null,
        senderAddressId,
        receiverAddressId,
        serviceType: payload.serviceType ?? null,
        codAmount: payload.codAmount ?? null,
        currency: payload.currency ?? null,
        weightKg: payload.weightKg ?? null,
        paymentType: payload.paymentType ?? null,
        paymentState: OrderPaymentState.UNPAID,
        deliveryChargePaidBy: payload.deliveryChargePaidBy ?? null,
        ifRecipientNotAvailable: payload.ifRecipientNotAvailable ?? null,
        codPaidStatus: "NOT_PAID",
        serviceCharge: payload.serviceCharge ?? null,
        serviceChargePaidStatus: "NOT_PAID",
        itemValue: payload.itemValue ?? null,
        plannedPickupAt: toDateOrNull(payload.plannedPickupAt),
        plannedDeliveryAt: toDateOrNull(payload.plannedDeliveryAt),
        promiseDate: toDateOrNull(payload.promiseDate),
        expectedDeliveryAt: slaSnapshot.expectedDeliveryAt,
        slaSource: slaSnapshot.slaSource,
        slaRuleId: slaSnapshot.slaRuleId,
        slaTargetDays: slaSnapshot.slaTargetDays,
        referenceId: payload.referenceId ?? null,
        shelfId: payload.shelfId ?? null,
        promoCode: payload.promoCode ?? null,
        numberOfCalls: payload.numberOfCalls ?? null,
        fragile: payload.fragile ?? false,
        dangerousGoods: payload.dangerousGoods ?? false,
        shipmentInsurance: payload.shipmentInsurance ?? false,
        createdAt,
        parcels: { create: parcelsToCreate },
        trackingEvents: {
          create: {
            status: OrderStatus.pending,
            note: "Order created",
            actorId: actor?.id ?? null,
            actorRole: normalizeActorRoleForTracking(),
            // User.warehouseId is not tenant-bound. A later warehouse slice must
            // establish that relationship before it can be copied to new events.
            warehouseId: null,
            region: null,
          },
        },
      },
      include: orderCreationInclude,
    });

    await enqueueCargoPilotDomainEventsTx(tx, [
      {
        type: "order_created",
        tenantScope: `tenant:${membership.tenantId}:company:${membership.companyId}`,
        entityId: created.id,
        payload: {
          source: "createOrder",
          orderNumber: created.orderNumber,
          actorId: actor?.id ?? null,
          actorRole: normalizeActorRoleForTracking(),
        },
      },
    ]);

    await tx.orderCreationReceipt.create({data:{intentId:intent.id,ordinal,tenantId:request.tenantId,companyId:request.companyId,orderId:created.id}});
    return {order:created,replayed:false};
  });
};


async function creationAuthority(tx: Prisma.TransactionClient, actor: OrderActor) {
  const membership=await requireTenantBoundOrderCompanyAuthority(tx,actor,"shipment.create");
  if(!hasCompanyScope(membership)||!membership.tenantId) throw authorityError("Company creation scope required",403);
  return membership;
}
async function lockCreation(tx: Prisma.TransactionClient, request: CreationRequest) {
  // Cast void result to text so Prisma never deserializes PostgreSQL void.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${request.tenantId+":order-creation:"+request.operationId},0))::text`;
}
async function resolveIntent(tx: Prisma.TransactionClient, actor: OrderActor, request: CreationRequest, create: boolean) {
  assertCreationRequest(actor,request,0);
  const existing=await tx.orderCreationIntent.findUnique({where:{tenantId_operationId:{tenantId:request.tenantId,operationId:request.operationId}}});
  if(existing){
    for(const key of ["userId","tenantId","companyId","tenantMembershipId","companyMembershipId","kind","fingerprint","normalizationVersion","rowCount"] as const)
      if(existing[key]!==request[key]) throw Object.assign(authorityError("Operation identity conflict",409), { code: "ORDER_CREATION_IDENTITY_CONFLICT" });
    return existing;
  }
  return create ? tx.orderCreationIntent.create({data:{...request}}) : null;
}
async function readReceipt(tx: Prisma.TransactionClient, actor: OrderActor, request: CreationRequest, intentId: string, ordinal: number) {
  const receipt=await tx.orderCreationReceipt.findUnique({where:{intentId_ordinal:{intentId,ordinal}}});
  if(!receipt) return null;
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${receipt.orderId}::uuid AND "tenantId"=${request.tenantId}::uuid AND "ownerOrgId"=${request.companyId}::uuid FOR SHARE`;
  const parent=await tx.order.findFirst({where:{id:receipt.orderId,tenantId:request.tenantId,ownerOrgId:request.companyId,customerId:request.userId},select:{id:true,customerEntityId:true,senderAddressId:true,receiverAddressId:true}});
  if (!parent) throw authorityError("Confirmed order is not accessible",403);
  await validateCreationReferences(tx,actor as AppUser,parent,true);
  const order=await tx.order.findFirst({where:{id:parent.id,tenantId:request.tenantId,ownerOrgId:request.companyId,customerId:request.userId},include:orderCreationInclude});
  if(!order||receipt.tenantId!==request.tenantId||receipt.companyId!==request.companyId) throw authorityError("Confirmed order is not accessible",403);
  return order;
}
function creationTransaction<T>(fn:(tx:Prisma.TransactionClient)=>Promise<T>) {
  return prisma.$transaction(async tx=>{
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '3000ms'");
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2000ms'");
    return fn(tx);
  },{maxWait:2000,timeout:8000});
}
export async function getOrderCreationRetry(actor:OrderActor,request:CreationRequest,ordinal=0) {
  assertCreationRequest(actor,request,ordinal);
  return creationTransaction(async tx=>{
    await lockCreation(tx,request); await creationAuthority(tx,actor);
    const intent=await resolveIntent(tx,actor,request,false);
    return intent ? readReceipt(tx,actor,request,intent.id,ordinal) : null;
  });
}
export async function acceptOrderImportIntent(actor:OrderActor,request:CreationRequest) {
  assertCreationRequest(actor,request,0);
  if(request.kind!=="import") throw authorityError("Import identity required");
  return creationTransaction(async tx=>{
    await lockCreation(tx,request); await creationAuthority(tx,actor);
    return resolveIntent(tx,actor,request,true);
  });
}
