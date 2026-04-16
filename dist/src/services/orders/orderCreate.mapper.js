"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOrderPayloadSchema = exports.parcelInputSchema = exports.addressSchema = void 0;
exports.mapCreateOrderDtoToRepoPayload = mapCreateOrderDtoToRepoPayload;
// src/modules/orders/orderCreate.mapper.ts
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const zod_1 = require("zod");
const orderAddress_shared_1 = require("./orderAddress.shared");
const order_constants_1 = require("./order.constants");
/**
 * Helpers
 */
// ✅ No-NaN optional number (same idea as your frontend)
const optionalNumber = () => zod_1.z.preprocess((v) => {
    if (v === "" || v === null || v === undefined)
        return undefined;
    const num = Number(v);
    return Number.isNaN(num) ? undefined : num;
}, zod_1.z.number().optional());
// Accept ISO date strings or null/undefined (don’t explode)
const optionalIsoDateString = () => zod_1.z
    .preprocess((v) => {
    if (v === "" || v === null || v === undefined)
        return undefined;
    return v;
}, zod_1.z.string().datetime().optional())
    .optional()
    .nullable();
/**
 * Schemas
 */
exports.addressSchema = zod_1.z.object({
    country: zod_1.z.string().optional().nullable(),
    city: zod_1.z.string().optional().nullable(),
    neighborhood: zod_1.z.string().optional().nullable(),
    street: zod_1.z.string().optional().nullable(),
    addressLine1: zod_1.z.string().optional().nullable(),
    addressLine2: zod_1.z.string().optional().nullable(),
    building: zod_1.z.string().optional().nullable(),
    apartment: zod_1.z.string().optional().nullable(),
    floor: zod_1.z.string().optional().nullable(),
    landmark: zod_1.z.string().optional().nullable(),
    postalCode: zod_1.z.string().optional().nullable(),
    addressType: zod_1.z.enum(["RESIDENTIAL", "BUSINESS"]).optional().nullable(),
});
exports.parcelInputSchema = zod_1.z.object({
    weightKg: optionalNumber().refine((v) => v == null || v > 0, "Must be > 0"),
    lengthCm: optionalNumber().refine((v) => v == null || v > 0, "Must be > 0"),
    widthCm: optionalNumber().refine((v) => v == null || v > 0, "Must be > 0"),
    heightCm: optionalNumber().refine((v) => v == null || v > 0, "Must be > 0"),
});
exports.createOrderPayloadSchema = zod_1.z
    .object({
    // ✅ allow null/undefined until you actually have customer entity
    customerEntityId: zod_1.z.string().optional().nullable(),
    // ✅ allow missing objects (prevents "expected object, received undefined")
    sender: zod_1.z
        .object({
        name: zod_1.z.string().optional().nullable(),
        phone: zod_1.z.string().optional().nullable(),
        phone2: zod_1.z.string().optional().nullable(),
        phone3: zod_1.z.string().optional().nullable(),
    })
        .optional()
        .nullable(),
    receiver: zod_1.z
        .object({
        name: zod_1.z.string().optional().nullable(),
        phone: zod_1.z.string().optional().nullable(),
        phone2: zod_1.z.string().optional().nullable(),
        phone3: zod_1.z.string().optional().nullable(),
    })
        .optional()
        .nullable(),
    addresses: zod_1.z.object({
        senderAddressId: zod_1.z.string().uuid().optional().nullable(),
        receiverAddressId: zod_1.z.string().uuid().optional().nullable(),
        senderAddress: exports.addressSchema.optional().nullable(),
        receiverAddress: exports.addressSchema.optional().nullable(),
        // ✅ decide business rule here:
        // if you want required:
        pickupAddress: zod_1.z.string().min(3, "Pickup address is required"),
        dropoffAddress: zod_1.z.string().min(3, "Dropoff address is required"),
        // if you want optional, switch to .optional()
        destinationCity: zod_1.z.string().optional().nullable(),
        savePickupToAddressBook: zod_1.z.boolean().optional().default(false),
        saveDropoffToAddressBook: zod_1.z.boolean().optional().default(false),
    }),
    shipment: zod_1.z.object({
        serviceType: zod_1.z
            .string()
            .optional()
            .nullable()
            .transform((value) => (0, order_constants_1.normalizeServiceTypeInput)(value))
            .pipe(zod_1.z.enum(order_constants_1.SERVICE_TYPES))
            .default(order_constants_1.DEFAULT_SERVICE_TYPE),
        weightKg: optionalNumber().refine((v) => v == null || v > 0, "Weight must be > 0"),
        // ✅ critical: stable boolean flag
        codEnabled: zod_1.z.boolean().default(false),
        codAmount: optionalNumber().refine((v) => v == null || v > 0, "COD amount must be > 0"),
        currency: zod_1.z.string().optional().nullable(),
        parcels: zod_1.z.array(exports.parcelInputSchema).optional().nullable(),
        pieceTotal: optionalNumber().refine((v) => v == null || v > 0, "pieceTotal must be > 0"),
        fragile: zod_1.z.boolean().optional(),
        dangerousGoods: zod_1.z.boolean().optional(),
        shipmentInsurance: zod_1.z.boolean().optional(),
        itemValue: optionalNumber().refine((v) => v == null || v >= 0, "itemValue must be >= 0"),
    }),
    payment: zod_1.z
        .object({
        paymentType: zod_1.z
            .enum(["CASH", "CARD", "COD", "TRANSFER", "OTHER"])
            .optional()
            .nullable(),
        deliveryChargePaidBy: zod_1.z
            .enum(["SENDER", "RECIPIENT", "COMPANY"])
            .optional()
            .nullable(),
        codPaidStatus: zod_1.z
            .enum(["NOT_PAID", "PAID", "PARTIAL"])
            .optional()
            .nullable(),
        // allow 0 or undefined based on your rule; here: optional
        serviceCharge: optionalNumber(),
        serviceChargePaidStatus: zod_1.z
            .enum(["NOT_PAID", "PAID", "PARTIAL"])
            .optional()
            .nullable(),
        ifRecipientNotAvailable: zod_1.z
            .enum([
            "DO_NOT_DELIVER",
            "LEAVE_AT_DOOR",
            "LEAVE_WITH_CONCIERGE",
            "CALL_SENDER",
            "RESCHEDULE",
            "RETURN_TO_SENDER",
        ])
            .optional()
            .nullable(),
    })
        .optional()
        .nullable(),
    schedule: zod_1.z
        .object({
        plannedPickupAt: optionalIsoDateString(),
        plannedDeliveryAt: optionalIsoDateString(),
        promiseDate: optionalIsoDateString(),
    })
        .optional()
        .nullable(),
    reference: zod_1.z
        .object({
        referenceId: zod_1.z.string().optional().nullable(),
        shelfId: zod_1.z.string().optional().nullable(),
        promoCode: zod_1.z.string().optional().nullable(),
        // ✅ calls can be 0
        numberOfCalls: optionalNumber(),
    })
        .optional()
        .nullable(),
    note: zod_1.z.string().optional().nullable(),
    // Stripe: optional
    amount: optionalNumber().refine((v) => v == null || v > 0, "Amount must be > 0"),
})
    .superRefine((v, ctx) => {
    // ✅ COD validation gate (only when enabled)
    const codEnabled = v.shipment?.codEnabled ?? false;
    if (codEnabled) {
        const amount = v.shipment?.codAmount;
        if (amount == null || amount <= 0) {
            ctx.addIssue({
                code: "custom",
                path: ["shipment", "codAmount"],
                message: "COD amount must be > 0",
            });
        }
        const cur = v.shipment?.currency;
        if (!cur || cur.trim().length < 2) {
            ctx.addIssue({
                code: "custom",
                path: ["shipment", "currency"],
                message: "Currency is required for COD",
            });
        }
    }
});
async function mapCreateOrderDtoToRepoPayload(raw) {
    const dto = exports.createOrderPayloadSchema.parse(raw);
    const senderAddressId = dto.addresses.senderAddressId ?? null;
    const receiverAddressId = dto.addresses.receiverAddressId ?? null;
    let pickupAddress = dto.addresses.pickupAddress;
    let dropoffAddress = dto.addresses.dropoffAddress;
    let destinationCity = dto.addresses.destinationCity ?? dto.addresses.receiverAddress?.city ?? null;
    // ✅ optional resolve from address book IDs
    if (senderAddressId || receiverAddressId) {
        const [senderAddr, receiverAddr] = await Promise.all([
            senderAddressId
                ? prismaClient_1.default.address.findFirst({
                    where: {
                        id: senderAddressId,
                        customerEntityId: dto.customerEntityId ?? undefined,
                    },
                })
                : Promise.resolve(null),
            receiverAddressId
                ? prismaClient_1.default.address.findUnique({ where: { id: receiverAddressId } })
                : Promise.resolve(null),
        ]);
        if (senderAddressId && !senderAddr) {
            const e = new Error("senderAddressId not found");
            e.statusCode = 400;
            throw e;
        }
        if (receiverAddressId && !receiverAddr) {
            const e = new Error("receiverAddressId not found");
            e.statusCode = 400;
            throw e;
        }
        if (senderAddr)
            pickupAddress = (0, orderAddress_shared_1.buildAddressText)(senderAddr);
        if (receiverAddr)
            dropoffAddress = (0, orderAddress_shared_1.buildAddressText)(receiverAddr);
        destinationCity = receiverAddr?.city ?? destinationCity;
    }
    return {
        pickupAddress,
        dropoffAddress,
        destinationCity,
        savePickupToAddressBook: dto.addresses.savePickupToAddressBook ?? false,
        saveDropoffToAddressBook: dto.addresses.saveDropoffToAddressBook ?? false,
        senderAddressSnapshot: dto.addresses.senderAddress ?? null,
        receiverAddressSnapshot: dto.addresses.receiverAddress ?? null,
        senderName: dto.sender?.name ?? null,
        senderPhone: dto.sender?.phone ?? null,
        senderPhone2: dto.sender?.phone2 ?? null,
        senderPhone3: dto.sender?.phone3 ?? null,
        receiverName: dto.receiver?.name ?? null,
        receiverPhone: dto.receiver?.phone ?? null,
        receiverPhone2: dto.receiver?.phone2 ?? null,
        receiverPhone3: dto.receiver?.phone3 ?? null,
        senderAddress: null,
        receiverAddress: null,
        customerEntityId: dto.customerEntityId ?? null,
        senderAddressId,
        receiverAddressId,
        serviceType: dto.shipment?.serviceType ?? order_constants_1.DEFAULT_SERVICE_TYPE,
        weightKg: dto.shipment?.weightKg ?? null,
        codAmount: dto.shipment?.codEnabled
            ? (dto.shipment?.codAmount ?? null)
            : null,
        currency: dto.shipment?.codEnabled
            ? (dto.shipment?.currency ?? null)
            : null,
        pieceTotal: dto.shipment?.pieceTotal ?? null,
        parcels: dto.shipment?.parcels ?? null,
        fragile: dto.shipment?.fragile ?? false,
        dangerousGoods: dto.shipment?.dangerousGoods ?? false,
        shipmentInsurance: dto.shipment?.shipmentInsurance ?? false,
        itemValue: dto.shipment?.itemValue ?? null,
        paymentType: dto.payment?.paymentType ?? null,
        deliveryChargePaidBy: dto.payment?.deliveryChargePaidBy ?? null,
        ifRecipientNotAvailable: dto.payment?.ifRecipientNotAvailable ??
            null,
        codPaidStatus: dto.payment?.codPaidStatus ?? null,
        serviceCharge: dto.payment?.serviceCharge ?? null,
        serviceChargePaidStatus: dto.payment?.serviceChargePaidStatus ?? null,
        plannedPickupAt: dto.schedule?.plannedPickupAt ?? null,
        plannedDeliveryAt: dto.schedule?.plannedDeliveryAt ?? null,
        promiseDate: dto.schedule?.promiseDate ?? null,
        referenceId: dto.reference?.referenceId ?? null,
        shelfId: dto.reference?.shelfId ?? null,
        promoCode: dto.reference?.promoCode ?? null,
        numberOfCalls: dto.reference?.numberOfCalls ?? null,
        amount: dto.amount,
    };
}
