import type { Prisma } from "@prisma/client";
import { buildMembershipOrderScopeWhere, loadAccessSnapshot } from "../../identity-access/access-control";
import type { AppUser } from "../../../types/app-user";
import { orderError, type OrderActor } from "../shared";

export type DispatchAuthority = { actor: OrderActor; scope: Prisma.OrderWhereInput };

/** Direct callers need the same fresh selected authority as protected HTTP callers. */
export async function requireDispatchAuthority(requested: OrderActor, permission: string): Promise<DispatchAuthority> {
  if (!requested?.id || !requested.companyMembershipId || requested.membershipId !== requested.companyMembershipId ||
      !requested.companyId || !requested.tenantId || !requested.tenantMembershipId) {
    throw orderError("Tenant-bound membership context required", 403);
  }
  const snapshot = await loadAccessSnapshot({ userId: requested.id, membershipId: requested.membershipId,
    companyMembershipId: requested.companyMembershipId, companyId: requested.companyId, tenantId: requested.tenantId,
    tenantMembershipId: requested.tenantMembershipId, requireFresh: true, explicitScopesOnly: true });
  if (!snapshot || !snapshot.permissionCodes.includes(permission)) throw orderError("Dispatch permission required", 403);
  const user: AppUser = { ...snapshot, id: snapshot.userId };
  const scope = await buildMembershipOrderScopeWhere(user, permission);
  if (!scope || scope.id === "__no_access__" ||
      (Array.isArray(scope.AND) && scope.AND.some(item => item.id === "__no_access__"))) throw orderError("Dispatch object scope required", 403);
  const warehouseId = snapshot.warehouseId && snapshot.scopes.some(item => item.scopeType === "warehouse" && item.scopeRefId === snapshot.warehouseId)
    ? snapshot.warehouseId : null;
  return { actor: { id: snapshot.userId, membershipId: snapshot.membershipId, companyMembershipId: snapshot.companyMembershipId,
    companyId: snapshot.companyId, tenantId: snapshot.tenantId, tenantMembershipId: snapshot.tenantMembershipId,
    branchId: snapshot.branchId, permissionCodes: snapshot.permissionCodes, roleCodes: snapshot.roleCodes,
    scopes: snapshot.scopes, warehouseId, customerEntityId: null }, scope };
}

export function dispatchOrderWhere(authority: DispatchAuthority, ids: string[]): Prisma.OrderWhereInput {
  return { AND: [authority.scope, { tenantId: authority.actor.tenantId! }, { id: { in: ids } },
    { OR: [{ ownerOrgId: authority.actor.companyId! }, { assignedOrgId: authority.actor.companyId! }] }] };
}
