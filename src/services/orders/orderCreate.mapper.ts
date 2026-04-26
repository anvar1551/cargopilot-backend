// src/modules/orders/orderCreate.mapper.ts
import prisma from "../../config/prismaClient";
import { z } from "zod";
import {
  PaymentType,
  PaidBy,
  PaidStatus,
  RecipientUnavailableAction,
} from "@prisma/client";
import { buildAddressText } from "./orderAddress.shared";
import {
  DEFAULT_SERVICE_TYPE,
  SERVICE_TYPES,
  type ServiceTypeValue,
  normalizeServiceTypeInput,
} from "./order.constants";

/**
 * Helpers
 */

// ✅ No-NaN optional number (same idea as your frontend)
const optionalNumber = () =>
  z.preprocess((v) => {
    if (v === "" || v === null || v === undefined) return undefined;
    const num = Number(v);
    return Number.isNaN(num) ? undefined : num;
  }, z.number().optional());

// Accept ISO date strings or null/undefined (don’t explode)
const optionalIsoDateString = () =>
  z
    .preprocess((v) => {
      if (v === "" || v === null || v === undefined) return undefined;
      return v;
    }, z.string().datetime().optional())
    .optional()
    .nullable();

function normalizeLatitude(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < -90 || value > 90) return null;
  return value;
}

function normalizeLongitude(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < -180 || value > 180) return null;
  return value;
}

function coordsEqual(
  aLat: number | null,
  aLng: number | null,
  bLat: number | null,
  bLng: number | null,
) {
  if (aLat == null || aLng == null || bLat == null || bLng == null) return false;
  return Math.abs(aLat - bLat) < 0.000001 && Math.abs(aLng - bLng) < 0.000001;
}

/**
 * Schemas
 */

export const addressSchema = z.object({
  country: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  neighborhood: z.string().optional().nullable(),
  street: z.string().optional().nullable(),
  latitude: z.number().optional().nullable(),
  longitude: z.number().optional().nullable(),
  addressLine1: z.string().optional().nullable(),
  addressLine2: z.string().optional().nullable(),
  building: z.string().optional().nullable(),
  apartment: z.string().optional().nullable(),
  floor: z.string().optional().nullable(),
  landmark: z.string().optional().nullable(),
  postalCode: z.string().optional().nullable(),
  addressType: z.enum(["RESIDENTIAL", "BUSINESS"]).optional().nullable(),
});

export const parcelInputSchema = z.object({
  weightKg: optionalNumber().refine((v) => v == null || v > 0, "Must be > 0"),
  lengthCm: optionalNumber().refine((v) => v == null || v > 0, "Must be > 0"),
  widthCm: optionalNumber().refine((v) => v == null || v > 0, "Must be > 0"),
  heightCm: optionalNumber().refine((v) => v == null || v > 0, "Must be > 0"),
});

export const createOrderPayloadSchema = z
  .object({
    // ✅ allow null/undefined until you actually have customer entity
    customerEntityId: z.string().optional().nullable(),

    // ✅ allow missing objects (prevents "expected object, received undefined")
    sender: z
      .object({
        name: z.string().optional().nullable(),
        phone: z.string().optional().nullable(),
        phone2: z.string().optional().nullable(),
        phone3: z.string().optional().nullable(),
      })
      .optional()
      .nullable(),

    receiver: z
      .object({
        name: z.string().optional().nullable(),
        phone: z.string().optional().nullable(),
        phone2: z.string().optional().nullable(),
        phone3: z.string().optional().nullable(),
      })
      .optional()
      .nullable(),

    addresses: z.object({
      senderAddressId: z.string().uuid().optional().nullable(),
      receiverAddressId: z.string().uuid().optional().nullable(),

      senderAddress: addressSchema.optional().nullable(),
      receiverAddress: addressSchema.optional().nullable(),

      // ✅ decide business rule here:
      // if you want required:
      pickupAddress: z.string().min(3, "Pickup address is required"),
      dropoffAddress: z.string().min(3, "Dropoff address is required"),
      // if you want optional, switch to .optional()
      destinationCity: z.string().optional().nullable(),

      savePickupToAddressBook: z.boolean().optional().default(false),
      saveDropoffToAddressBook: z.boolean().optional().default(false),
    }),

    shipment: z.object({
      serviceType: z
        .string()
        .optional()
        .nullable()
        .transform((value) => normalizeServiceTypeInput(value))
        .pipe(z.enum(SERVICE_TYPES))
        .default(DEFAULT_SERVICE_TYPE),

      weightKg: optionalNumber().refine(
        (v) => v == null || v > 0,
        "Weight must be > 0",
      ),

      // ✅ critical: stable boolean flag
      codEnabled: z.boolean().default(false),

      codAmount: optionalNumber().refine(
        (v) => v == null || v > 0,
        "COD amount must be > 0",
      ),

      currency: z.string().optional().nullable(),

      parcels: z.array(parcelInputSchema).optional().nullable(),

      pieceTotal: optionalNumber().refine(
        (v) => v == null || v > 0,
        "pieceTotal must be > 0",
      ),

      fragile: z.boolean().optional(),
      dangerousGoods: z.boolean().optional(),
      shipmentInsurance: z.boolean().optional(),

      itemValue: optionalNumber().refine(
        (v) => v == null || v >= 0,
        "itemValue must be >= 0",
      ),
    }),

    payment: z
      .object({
        paymentType: z
          .enum(["CASH", "CARD", "COD", "TRANSFER", "OTHER"])
          .optional()
          .nullable(),

        deliveryChargePaidBy: z
          .enum(["SENDER", "RECIPIENT", "COMPANY"])
          .optional()
          .nullable(),

        codPaidStatus: z
          .enum(["NOT_PAID", "PAID", "PARTIAL"])
          .optional()
          .nullable(),

        // allow 0 or undefined based on your rule; here: optional
        serviceCharge: optionalNumber(),

        serviceChargePaidStatus: z
          .enum(["NOT_PAID", "PAID", "PARTIAL"])
          .optional()
          .nullable(),

        ifRecipientNotAvailable: z
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

    schedule: z
      .object({
        plannedPickupAt: optionalIsoDateString(),
        plannedDeliveryAt: optionalIsoDateString(),
        promiseDate: optionalIsoDateString(),
      })
      .optional()
      .nullable(),

    reference: z
      .object({
        referenceId: z.string().optional().nullable(),
        shelfId: z.string().optional().nullable(),
        promoCode: z.string().optional().nullable(),
        // ✅ calls can be 0
        numberOfCalls: optionalNumber(),
      })
      .optional()
      .nullable(),

    note: z.string().optional().nullable(),

    // Stripe: optional
    amount: optionalNumber().refine(
      (v) => v == null || v > 0,
      "Amount must be > 0",
    ),
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

export type CreateOrderPayloadDto = z.infer<typeof createOrderPayloadSchema>;

/**
 * Repo payload (same as yours)
 */
export type CreateOrderRepoPayload = {
  pickupAddress: string;
  dropoffAddress: string;
  destinationCity?: string | null;
  pickupLat?: number | null;
  pickupLng?: number | null;
  dropoffLat?: number | null;
  dropoffLng?: number | null;
  savePickupToAddressBook?: boolean;
  saveDropoffToAddressBook?: boolean;
  senderAddressSnapshot?: any | null;
  receiverAddressSnapshot?: any | null;

  senderName?: string | null;
  senderPhone?: string | null;
  senderPhone2?: string | null;
  senderPhone3?: string | null;
  receiverName?: string | null;
  receiverPhone?: string | null;
  receiverPhone2?: string | null;
  receiverPhone3?: string | null;

  senderAddress?: string | null;
  receiverAddress?: string | null;

  customerEntityId?: string | null;
  senderAddressId?: string | null;
  receiverAddressId?: string | null;

  serviceType?: ServiceTypeValue | null;
  weightKg?: number | null;
  codAmount?: number | null;
  currency?: string | null;

  paymentType?: PaymentType | null;
  deliveryChargePaidBy?: PaidBy | null;
  ifRecipientNotAvailable?: RecipientUnavailableAction | null;

  codPaidStatus?: PaidStatus | null;
  serviceCharge?: number | null;
  serviceChargePaidStatus?: PaidStatus | null;
  itemValue?: number | null;

  plannedPickupAt?: Date | string | null;
  plannedDeliveryAt?: Date | string | null;
  promiseDate?: Date | string | null;

  referenceId?: string | null;
  shelfId?: string | null;
  promoCode?: string | null;
  numberOfCalls?: number | null;

  fragile?: boolean;
  dangerousGoods?: boolean;
  shipmentInsurance?: boolean;

  pieceTotal?: number | null;
  parcels?: Array<{
    weightKg?: number | null;
    lengthCm?: number | null;
    widthCm?: number | null;
    heightCm?: number | null;
  }> | null;

  amount?: number | undefined;
};

export async function mapCreateOrderDtoToRepoPayload(
  raw: unknown,
): Promise<CreateOrderRepoPayload> {
  const dto = createOrderPayloadSchema.parse(raw);

  const senderAddressId = dto.addresses.senderAddressId ?? null;
  const receiverAddressId = dto.addresses.receiverAddressId ?? null;

  let pickupAddress = dto.addresses.pickupAddress;
  let dropoffAddress = dto.addresses.dropoffAddress;
  let destinationCity =
    dto.addresses.destinationCity ?? dto.addresses.receiverAddress?.city ?? null;
  let senderAddr: {
    latitude?: number | null;
    longitude?: number | null;
    city?: string | null;
  } | null = null;
  let receiverAddr: {
    latitude?: number | null;
    longitude?: number | null;
    city?: string | null;
  } | null = null;

  // ✅ optional resolve from address book IDs
  if (senderAddressId || receiverAddressId) {
    const [resolvedSenderAddr, resolvedReceiverAddr] = await Promise.all([
      senderAddressId
        ? prisma.address.findFirst({
            where: {
              id: senderAddressId,
              customerEntityId: dto.customerEntityId ?? undefined,
            },
          })
        : Promise.resolve(null),
      receiverAddressId
        ? prisma.address.findUnique({ where: { id: receiverAddressId } })
        : Promise.resolve(null),
    ]);

    if (senderAddressId && !resolvedSenderAddr) {
      const e: any = new Error("senderAddressId not found");
      e.statusCode = 400;
      throw e;
    }
    if (receiverAddressId && !resolvedReceiverAddr) {
      const e: any = new Error("receiverAddressId not found");
      e.statusCode = 400;
      throw e;
    }

    senderAddr = resolvedSenderAddr;
    receiverAddr = resolvedReceiverAddr;

    if (senderAddr) pickupAddress = buildAddressText(senderAddr);
    if (receiverAddr) dropoffAddress = buildAddressText(receiverAddr);
    destinationCity = receiverAddr?.city ?? destinationCity;
  }

  const pickupLatFromSnapshot = normalizeLatitude(
    dto.addresses.senderAddress?.latitude,
  );
  const pickupLngFromSnapshot = normalizeLongitude(
    dto.addresses.senderAddress?.longitude,
  );
  const dropoffLatFromSnapshot = normalizeLatitude(
    dto.addresses.receiverAddress?.latitude,
  );
  const dropoffLngFromSnapshot = normalizeLongitude(
    dto.addresses.receiverAddress?.longitude,
  );

  const pickupLatFromAddressBook = normalizeLatitude(senderAddr?.latitude);
  const pickupLngFromAddressBook = normalizeLongitude(senderAddr?.longitude);
  const dropoffLatFromAddressBook = normalizeLatitude(receiverAddr?.latitude);
  const dropoffLngFromAddressBook = normalizeLongitude(receiverAddr?.longitude);

  let pickupLat =
    senderAddressId && pickupLatFromAddressBook != null
      ? pickupLatFromAddressBook
      : pickupLatFromSnapshot;
  let pickupLng =
    senderAddressId && pickupLngFromAddressBook != null
      ? pickupLngFromAddressBook
      : pickupLngFromSnapshot;
  let dropoffLat =
    receiverAddressId && dropoffLatFromAddressBook != null
      ? dropoffLatFromAddressBook
      : dropoffLatFromSnapshot;
  let dropoffLng =
    receiverAddressId && dropoffLngFromAddressBook != null
      ? dropoffLngFromAddressBook
      : dropoffLngFromSnapshot;

  if (
    coordsEqual(pickupLat, pickupLng, dropoffLat, dropoffLng) &&
    pickupAddress.trim() !== dropoffAddress.trim()
  ) {
    const receiverPreferredLat =
      dropoffLatFromAddressBook ?? dropoffLatFromSnapshot;
    const receiverPreferredLng =
      dropoffLngFromAddressBook ?? dropoffLngFromSnapshot;

    if (
      receiverPreferredLat != null &&
      receiverPreferredLng != null &&
      !coordsEqual(pickupLat, pickupLng, receiverPreferredLat, receiverPreferredLng)
    ) {
      dropoffLat = receiverPreferredLat;
      dropoffLng = receiverPreferredLng;
    } else {
      console.warn(
        "[orders] pickup/dropoff coordinates are identical while addresses differ",
        {
          pickupAddress,
          dropoffAddress,
          senderAddressId,
          receiverAddressId,
          pickupLat,
          pickupLng,
          dropoffLat,
          dropoffLng,
        },
      );
    }
  }

  return {
    pickupAddress,
    dropoffAddress,
    destinationCity,
    pickupLat,
    pickupLng,
    dropoffLat,
    dropoffLng,

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

    serviceType: dto.shipment?.serviceType ?? DEFAULT_SERVICE_TYPE,
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

    paymentType: (dto.payment?.paymentType as PaymentType) ?? null,
    deliveryChargePaidBy: (dto.payment?.deliveryChargePaidBy as PaidBy) ?? null,
    ifRecipientNotAvailable:
      (dto.payment?.ifRecipientNotAvailable as RecipientUnavailableAction) ??
      null,

    codPaidStatus: (dto.payment?.codPaidStatus as PaidStatus) ?? null,
    serviceCharge: dto.payment?.serviceCharge ?? null,
    serviceChargePaidStatus:
      (dto.payment?.serviceChargePaidStatus as PaidStatus) ?? null,

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
