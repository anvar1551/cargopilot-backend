import prisma from "../../../config/prismaClient";
import { emitAnalyticsInvalidationForMutation } from "../../../middleware/analyticsInvalidate";
import { authorize, buildOrderScopeWhere } from "../../identity-access";

export function parseMaxPhotoBytes() {
  const fallback = 6 * 1024 * 1024;
  const raw = Number(process.env.DELIVERY_PROOF_MAX_PHOTO_BYTES ?? fallback);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.floor(raw);
}

export function fieldValue(field: any) {
  if (field == null) return undefined;
  if (typeof field === "string") return field;
  if (typeof field.value === "string") return field.value;
  return undefined;
}

export function asEnumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fieldName: string,
): T | undefined {
  if (value == null || value === "") return undefined;
  const asText = String(value).trim();
  if ((allowed as readonly string[]).includes(asText)) {
    return asText as T;
  }
  const err = new Error(`Invalid ${fieldName}: ${asText}`) as Error & { statusCode: number };
  err.statusCode = 400;
  throw err;
}

export function parseNumber(value: unknown, fieldName: string, required = false) {
  if (value == null || value === "") {
    if (required) {
      const err = new Error(`${fieldName} is required`) as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    }
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    const err = new Error(`${fieldName} must be a number`) as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  return parsed;
}

export async function emitMutationInvalidation(reason: "order_mutation" | "cash_mutation") {
  await emitAnalyticsInvalidationForMutation({ reason });
}

export function sendError(reply: any, err: any, fallback = "Failed") {
  return reply.code(err?.statusCode ?? 500).send({ error: err?.message ?? fallback });
}

export async function ensureOrderInScope(request: any, orderId: string) {
  const user = request.user;
  if (!user) {
    const err = new Error("Unauthorized") as Error & { statusCode: number };
    err.statusCode = 401;
    throw err;
  }
  await authorize(user, "shipment.view");
  const scopeWhere = (await buildOrderScopeWhere(user)) ?? { id: "__no_access__" };
  const order = await prisma.order.findFirst({
    where: { AND: [{ id: orderId }, scopeWhere] },
    select: { id: true },
  });
  if (!order) {
    const err = new Error("Order not found") as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }
}
