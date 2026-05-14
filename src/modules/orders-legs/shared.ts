import {
  PricingComponentSource,
  PricingComponentType,
  TransportMode,
  type OrderLegStatus,
} from "@prisma/client";
import prisma from "../../config/prismaClient";
import { orderError } from "../orders-core/shared";

export type Actor = {
  id: string;
  role?: string | null;
  userRole?: string | null;
  tenantScope?: string | null;
  warehouseId?: string | null;
};

export type UpsertOrderLegInput = {
  legId?: string | null;
  sequence?: number | null;
  mode?: TransportMode | null;
  status?: OrderLegStatus | null;
  fromCountry?: string | null;
  toCountry?: string | null;
  transitRoute?: unknown;
  fromWarehouseId?: string | null;
  toWarehouseId?: string | null;
  carrierCode?: string | null;
  carrierRef?: string | null;
  vehicleRef?: string | null;
  plannedDepartureAt?: string | Date | null;
  plannedArrivalAt?: string | Date | null;
  actualDepartureAt?: string | Date | null;
  actualArrivalAt?: string | Date | null;
  notes?: string | null;
  metadata?: unknown;
};

export type CreatePricingComponentInput = {
  orderLegId?: string | null;
  componentType: PricingComponentType;
  source?: PricingComponentSource | null;
  description?: string | null;
  amount: number;
  currency: string;
  fxRateSnapshot?: number | null;
  baseCurrency?: string | null;
  baseAmount?: number | null;
  referenceKey?: string | null;
};

export function toDate(value?: string | Date | null) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw orderError(`Invalid date: ${value}`, 400);
  }
  return parsed;
}

export function resolveActorTenantScope(actor?: Actor) {
  if (actor?.tenantScope) {
    return actor.tenantScope;
  }
  if (actor?.warehouseId) {
    return `warehouse:${actor.warehouseId}`;
  }
  if (actor?.id) {
    return `user:${actor.id}`;
  }
  return "system";
}

export async function ensureOrderExists(orderId: string) {
  const exists = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true },
  });
  if (!exists) {
    throw orderError("Order not found", 404);
  }
}
