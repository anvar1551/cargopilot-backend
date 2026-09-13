import { Prisma } from "@prisma/client";
import type { AppUser } from "../../../types/app-user";
import {
  buildCustomerEntityScopeWhere,
  loadAccessSnapshot,
} from "../../identity-access/access-control";

export type CustomerAccessContext = AppUser;

export function customerAccessError(message: string, statusCode = 403) {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function normalizeContext(input: CustomerAccessContext) {
  const context = {
    userId: String(input?.id ?? "").trim(),
    membershipId: String(input?.membershipId ?? "").trim(),
    companyMembershipId: String(input?.companyMembershipId ?? "").trim(),
    companyId: String(input?.companyId ?? "").trim(),
    tenantId: String(input?.tenantId ?? "").trim(),
    tenantMembershipId: String(input?.tenantMembershipId ?? "").trim(),
  };
  if (!context.userId || !context.membershipId || !context.companyMembershipId
    || !context.companyId || !context.tenantId || !context.tenantMembershipId
    || context.membershipId !== context.companyMembershipId) {
    throw customerAccessError("Active customer context required");
  }
  return context;
}

export async function requireCustomerAccess(
  input: CustomerAccessContext,
  permission: "customers.read" | "customers.write",
) {
  const expected = normalizeContext(input);
  const snapshot = await loadAccessSnapshot({
    userId: expected.userId,
    membershipId: expected.membershipId,
    companyMembershipId: expected.companyMembershipId,
    companyId: expected.companyId,
    tenantId: expected.tenantId,
    tenantMembershipId: expected.tenantMembershipId,
    requireFresh: true,
  });
  if (!snapshot || !snapshot.permissionCodes.includes(permission)) {
    throw customerAccessError("Forbidden");
  }

  const scope = await buildCustomerEntityScopeWhere({
    ...input,
    id: snapshot.userId,
    membershipId: snapshot.membershipId,
    companyMembershipId: snapshot.companyMembershipId,
    companyId: snapshot.companyId,
    tenantId: snapshot.tenantId,
    tenantMembershipId: snapshot.tenantMembershipId,
    branchId: snapshot.branchId,
    warehouseId: snapshot.warehouseId,
    customerEntityId: snapshot.customerEntityId,
    email: snapshot.email,
    name: snapshot.name,
    roleCodes: snapshot.roleCodes,
    permissionCodes: snapshot.permissionCodes,
    scopes: snapshot.scopes,
  });
  if (scope && "id" in scope && scope.id === "__no_access__") {
    throw customerAccessError("Forbidden");
  }

  const customerWhere: Prisma.CustomerEntityWhereInput = {
    tenantId: snapshot.tenantId,
    ...(scope ? { AND: [scope] } : {}),
  };
  return { snapshot, customerWhere, hasTenantWideCustomerScope: scope === null };
}

export function rejectOwnershipFields(input: object, fields: string[]) {
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      throw customerAccessError(`${field} is server controlled`, 400);
    }
  }
}
