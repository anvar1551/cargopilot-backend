import type { AppUser } from "../../../types/app-user";
import type { Prisma } from "@prisma/client";
import { loadAccessSnapshot, buildOrderScopeWhere } from "../../identity-access/access-control";

const deny = () => Object.assign(new Error("Invoice access denied"), { statusCode: 403 });
export async function authorizedInvoiceWhere(actor: AppUser, permission: string): Promise<Prisma.InvoiceWhereInput> {
  if (!actor?.id || !actor.tenantId || !actor.tenantMembershipId || !actor.companyId ||
      !actor.companyMembershipId || actor.membershipId !== actor.companyMembershipId) throw deny();
  const snapshot = await loadAccessSnapshot({ userId: actor.id, membershipId: actor.membershipId,
    companyMembershipId: actor.companyMembershipId, companyId: actor.companyId,
    tenantId: actor.tenantId, tenantMembershipId: actor.tenantMembershipId, requireFresh: true });
  if (!snapshot || snapshot.userId !== actor.id || snapshot.membershipId !== actor.membershipId ||
      snapshot.companyMembershipId !== actor.companyMembershipId || snapshot.tenantId !== actor.tenantId ||
      snapshot.tenantMembershipId !== actor.tenantMembershipId || snapshot.companyId !== actor.companyId ||
      !snapshot.permissionCodes.includes(permission)) throw deny();
  const scope = await buildOrderScopeWhere({ ...actor, ...snapshot, id: snapshot.userId }, permission);
  // The established helper uses denial sentinels inside AND for absent customer/object scopes.
  // Its current policy never mixes this sentinel with an allowed OR alternative.
  if (!scope || !Object.keys(scope).length || JSON.stringify(scope).includes('"__no_access__"')) throw deny();
  return { tenantId: snapshot.tenantId, companyId: snapshot.companyId,
    AND: [{ OR: [{ customerEntityId: null }, { customerEntity: { is: { tenantId: snapshot.tenantId } } }] }],
    order: { is: { AND: [{ tenantId: snapshot.tenantId, ownerOrgId: snapshot.companyId }, scope] } } };
}
