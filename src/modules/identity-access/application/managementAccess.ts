import type { AppUser } from "../../../types/app-user";
import { loadAccessSnapshot } from "../access-control";

export const ADMINISTRATIVE_CONTAINMENT = "Administrative access changes are unavailable pending an approved delegation policy";
export function rejectAdministrativeMutation(): never {
  throw Object.assign(new Error(ADMINISTRATIVE_CONTAINMENT), { statusCode: 403, code: "DELEGATION_POLICY_REQUIRED" });
}

/** Read-only management authority; deliberately confers no delegation capability. */
export async function requireIdentityManagementContext(actor: AppUser, permission: string) {
  if (!actor?.id || !actor.tenantId || !actor.tenantMembershipId || !actor.companyId ||
      !actor.companyMembershipId || actor.membershipId !== actor.companyMembershipId) {
    throw Object.assign(new Error("Tenant-bound management context required"), { statusCode: 403 });
  }
  const snapshot = await loadAccessSnapshot({ userId: actor.id, membershipId: actor.membershipId,
    companyMembershipId: actor.companyMembershipId, companyId: actor.companyId,
    tenantId: actor.tenantId, tenantMembershipId: actor.tenantMembershipId, requireFresh: true });
  if (!snapshot || snapshot.userId !== actor.id || snapshot.membershipId !== actor.membershipId ||
      snapshot.companyMembershipId !== actor.companyMembershipId || snapshot.companyId !== actor.companyId ||
      snapshot.tenantId !== actor.tenantId || snapshot.tenantMembershipId !== actor.tenantMembershipId ||
      !snapshot.permissionCodes.includes(permission) || !snapshot.scopes.some(scope =>
        scope.scopeType === "company" && scope.scopeRefId === snapshot.companyId)) {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  }
  return snapshot;
}
