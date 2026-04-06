import { AppRole } from "@prisma/client";

export type OrderActor = {
  id: string;
  role: AppRole;
  warehouseId?: string | null;
};

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/** Max number of order ids accepted by one bulk write operation. */
export const ORDER_BULK_MAX_IDS = parsePositiveInt(
  process.env.ORDER_BULK_MAX_IDS,
  100,
);

type AuthLikeUser =
  | {
      id?: string | null;
      role?: AppRole | string | null;
      warehouseId?: string | null;
    }
  | null
  | undefined;

/**
 * Creates an Error object with HTTP-like status metadata used by order services.
 */
export function orderError(message: string, statusCode = 400) {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = statusCode;
  return e;
}

/**
 * Converts auth middleware user payload into a strict order-service actor.
 */
export function toOrderActor(user: AuthLikeUser): OrderActor | null {
  if (!user?.id || !user?.role) return null;
  return {
    id: user.id,
    role: user.role as AppRole,
    warehouseId: user.warehouseId ?? null,
  };
}

/**
 * Returns an actor or throws a 401 service error when auth context is missing.
 */
export function requireOrderActor(user: AuthLikeUser): OrderActor {
  const actor = toOrderActor(user);
  if (!actor) {
    throw orderError("Unauthorized", 401);
  }
  return actor;
}

/**
 * Validates and normalizes bulk order id arrays.
 * - rejects empty or non-string input
 * - removes duplicates
 * - enforces hard server-side max size
 */
export function normalizeBulkOrderIds(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw orderError("orderIds must be a non-empty array", 400);
  }

  const normalized = Array.from(
    new Set(
      input
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean),
    ),
  );

  if (normalized.length === 0) {
    throw orderError("orderIds must contain valid id strings", 400);
  }

  if (normalized.length > ORDER_BULK_MAX_IDS) {
    throw orderError(
      `Too many orderIds: ${normalized.length}. Maximum is ${ORDER_BULK_MAX_IDS}.`,
      400,
    );
  }

  return normalized;
}
