"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOrder = void 0;
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const client_1 = require("@prisma/client");
const orderNumber_1 = require("../../../utils/orderNumber");
const orderService_shared_1 = require("../orderService.shared");
const order_repo_shared_1 = require("./order-repo.shared");
function sanitizeSnapshot(s) {
    if (!s || typeof s !== "object")
        return null;
    return {
        country: s.country ?? null,
        city: s.city ?? null,
        neighborhood: s.neighborhood ?? null,
        street: s.street ?? null,
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
function toDateOrNull(v) {
    if (v === undefined || v === null)
        return null;
    if (v instanceof Date)
        return v;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}
async function assertFkExists(payload) {
    if (payload.customerEntityId) {
        const exists = await prismaClient_1.default.customerEntity.findUnique({
            where: { id: payload.customerEntityId },
            select: { id: true },
        });
        if (!exists) {
            throw (0, orderService_shared_1.orderError)("customerEntityId not found", 400);
        }
    }
    if (payload.senderAddressId) {
        const exists = await prismaClient_1.default.address.findUnique({
            where: { id: payload.senderAddressId },
            select: { id: true },
        });
        if (!exists) {
            throw (0, orderService_shared_1.orderError)("senderAddressId not found", 400);
        }
    }
    if (payload.receiverAddressId) {
        const exists = await prismaClient_1.default.address.findUnique({
            where: { id: payload.receiverAddressId },
            select: { id: true },
        });
        if (!exists) {
            throw (0, orderService_shared_1.orderError)("receiverAddressId not found", 400);
        }
    }
}
/** Persists a new order with related parcels and initial tracking event. */
const createOrder = async (customerId, payload, actor) => {
    const wantsSavePickup = payload.savePickupToAddressBook === true;
    const wantsSaveDropoff = payload.saveDropoffToAddressBook === true;
    if ((wantsSavePickup || wantsSaveDropoff) && !payload.customerEntityId) {
        throw (0, orderService_shared_1.orderError)("customerEntityId is required to save addresses", 400);
    }
    if (wantsSavePickup && !payload.senderAddressId) {
        const snap = sanitizeSnapshot(payload.senderAddressSnapshot);
        if (!snap) {
            throw (0, orderService_shared_1.orderError)("senderAddress (structured) is required to save pickup address", 400);
        }
    }
    if (wantsSaveDropoff && !payload.receiverAddressId) {
        const snap = sanitizeSnapshot(payload.receiverAddressSnapshot);
        if (!snap) {
            throw (0, orderService_shared_1.orderError)("receiverAddress (structured) is required to save dropoff address", 400);
        }
    }
    let senderAddressId = payload.senderAddressId ?? null;
    let receiverAddressId = payload.receiverAddressId ?? null;
    if (wantsSavePickup && !senderAddressId) {
        const snap = sanitizeSnapshot(payload.senderAddressSnapshot);
        const created = await prismaClient_1.default.address.create({
            data: {
                customerEntityId: payload.customerEntityId,
                ...snap,
                isSaved: true,
            },
            select: { id: true },
        });
        senderAddressId = created.id;
    }
    if (wantsSaveDropoff && !receiverAddressId) {
        const snap = sanitizeSnapshot(payload.receiverAddressSnapshot);
        const created = await prismaClient_1.default.address.create({
            data: {
                customerEntityId: payload.customerEntityId,
                ...snap,
                isSaved: true,
            },
            select: { id: true },
        });
        receiverAddressId = created.id;
    }
    await assertFkExists({ ...payload, senderAddressId, receiverAddressId });
    const orderNumber = await (0, orderNumber_1.getNextOrderNumber)();
    const pieceTotal = payload.pieceTotal ??
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
    return prismaClient_1.default.order.create({
        data: {
            customerId,
            orderNumber,
            status: client_1.OrderStatus.pending,
            pickupAddress: payload.pickupAddress,
            dropoffAddress: payload.dropoffAddress,
            destinationCity: payload.destinationCity ?? null,
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
            customerEntityId: payload.customerEntityId ?? null,
            senderAddressId,
            receiverAddressId,
            serviceType: payload.serviceType ?? null,
            codAmount: payload.codAmount ?? null,
            currency: payload.currency ?? null,
            weightKg: payload.weightKg ?? null,
            paymentType: payload.paymentType ?? null,
            deliveryChargePaidBy: payload.deliveryChargePaidBy ?? null,
            ifRecipientNotAvailable: payload.ifRecipientNotAvailable ?? null,
            codPaidStatus: payload.codPaidStatus ?? null,
            serviceCharge: payload.serviceCharge ?? null,
            serviceChargePaidStatus: payload.serviceChargePaidStatus ?? null,
            itemValue: payload.itemValue ?? null,
            plannedPickupAt: toDateOrNull(payload.plannedPickupAt),
            plannedDeliveryAt: toDateOrNull(payload.plannedDeliveryAt),
            promiseDate: toDateOrNull(payload.promiseDate),
            referenceId: payload.referenceId ?? null,
            shelfId: payload.shelfId ?? null,
            promoCode: payload.promoCode ?? null,
            numberOfCalls: payload.numberOfCalls ?? null,
            fragile: payload.fragile ?? false,
            dangerousGoods: payload.dangerousGoods ?? false,
            shipmentInsurance: payload.shipmentInsurance ?? false,
            parcels: { create: parcelsToCreate },
            trackingEvents: {
                create: {
                    status: client_1.OrderStatus.pending,
                    note: "Order created",
                    actorId: actor?.id ?? null,
                    actorRole: actor?.role ?? null,
                    warehouseId: actor?.warehouseId ?? null,
                    region: null,
                },
            },
        },
        include: {
            customer: { select: order_repo_shared_1.userLiteSelect },
            customerEntity: true,
            senderAddressObj: true,
            receiverAddressObj: true,
            attachments: true,
            parcels: true,
            currentWarehouse: true,
            assignedDriver: { select: order_repo_shared_1.userLiteSelect },
            invoice: true,
            trackingEvents: {
                include: {
                    actor: { select: order_repo_shared_1.userLiteSelect },
                    warehouse: true,
                    parcel: true,
                },
                orderBy: { timestamp: "asc" },
            },
        },
    });
};
exports.createOrder = createOrder;
