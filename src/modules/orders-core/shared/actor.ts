export type OrderActor = {
  id: string;
  membershipId?: string | null;
  companyId?: string | null;
  branchId?: string | null;
  roleCodes?: string[];
  permissionCodes?: string[];
  scopes?: Array<{
    scopeType:
      | "company"
      | "branch"
      | "warehouse"
      | "agent"
      | "pickup_point"
      | "carrier"
      | "client";
    scopeRefId: string;
  }>;
  tenantScope?: string | null;
  warehouseId?: string | null;
  customerEntityId?: string | null;
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
      membershipId?: string | null;
      companyId?: string | null;
      branchId?: string | null;
      roleCodes?: string[] | null;
      permissionCodes?: string[] | null;
      scopes?:
        | Array<{
            scopeType:
              | "company"
              | "branch"
              | "warehouse"
              | "agent"
              | "pickup_point"
              | "carrier"
              | "client";
            scopeRefId: string;
          }>
        | null;
      tenantScope?: string | null;
      warehouseId?: string | null;
      customerEntityId?: string | null;
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
  if (!user?.id) return null;
  return {
    id: user.id,
    membershipId: user.membershipId ?? null,
    companyId: user.companyId ?? null,
    branchId: user.branchId ?? null,
    roleCodes: Array.isArray(user.roleCodes) ? user.roleCodes : [],
    permissionCodes: Array.isArray(user.permissionCodes) ? user.permissionCodes : [],
    scopes: Array.isArray(user.scopes) ? user.scopes : [],
    tenantScope: typeof user.tenantScope === "string" ? user.tenantScope : null,
    warehouseId: user.warehouseId ?? null,
    customerEntityId: user.customerEntityId ?? null,
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
