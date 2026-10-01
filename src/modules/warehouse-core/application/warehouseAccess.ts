import type { AppUser } from "../../../types/app-user";
import { loadAccessSnapshot } from "../../identity-access/access-control";

export function warehouseAccessError(message: string, statusCode = 403) {
  return Object.assign(new Error(message), { statusCode });
}

export async function requireWarehouseAccess(context: AppUser, permission: string) {
  if (!context?.id || !context.tenantId || !context.tenantMembershipId ||
      !context.companyId || !context.companyMembershipId || context.membershipId !== context.companyMembershipId) {
    throw warehouseAccessError("Tenant-bound warehouse context required");
  }
  const snapshot = await loadAccessSnapshot({ userId: context.id, membershipId: context.membershipId,
    companyMembershipId: context.companyMembershipId, companyId: context.companyId,
    tenantId: context.tenantId, tenantMembershipId: context.tenantMembershipId, requireFresh: true });
  if (!snapshot || snapshot.userId !== context.id || snapshot.membershipId !== context.membershipId ||
      snapshot.companyMembershipId !== context.companyMembershipId || snapshot.companyId !== context.companyId ||
      snapshot.tenantId !== context.tenantId || snapshot.tenantMembershipId !== context.tenantMembershipId ||
      !snapshot.permissionCodes.includes(permission)) throw warehouseAccessError("Forbidden");
  // No company-owner relation: a company, role or global user assignment is not warehouse scope.
  const ids = [...new Set(snapshot.scopes.filter(s => s.scopeType === "warehouse").map(s => s.scopeRefId))];
  if (permission !== "warehouse.create" && !ids.length) throw warehouseAccessError("Explicit warehouse scope required");
  if (permission === "warehouse.create" && !snapshot.scopes.some(s => s.scopeType === "company" && s.scopeRefId === snapshot.companyId)) {
    throw warehouseAccessError("Selected company scope required for warehouse creation");
  }
  return { snapshot, where: { tenantId: snapshot.tenantId, id: { in: ids } } };
}

export function rejectWarehouseFields(input: object) {
  const allowed = new Set(["name", "type", "location", "region", "latitude", "longitude"]);
  if (Object.keys(input).some(key => !allowed.has(key))) throw warehouseAccessError("Unsupported or server-controlled warehouse field", 400);
}

/** Global links cannot express selected-membership ownership. No assignment effects allowed. */
export function rejectGlobalWarehouseAssignments(input: { warehouseId?: unknown; primaryWarehouseId?: unknown; warehouseIds?: unknown; scopes?: unknown }) {
  if (input.warehouseId !== undefined || input.primaryWarehouseId !== undefined || input.warehouseIds !== undefined ||
      (Array.isArray(input.scopes) && input.scopes.some(s => String(s?.scopeType ?? "").trim().toLowerCase() === "warehouse"))) {
    throw warehouseAccessError("Warehouse assignment changes require a membership-scoped assignment model");
  }
}
