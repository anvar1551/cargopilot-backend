import type { Prisma } from "@prisma/client";
import { authorityError } from "./creation-authority";

/** Fresh compatibility membership; selected company and token permission claims are not authority. */
export async function requireCompanyAuthority(
  db: Pick<Prisma.TransactionClient, "companyMembership">,
  actor: { id: string; membershipId?: string | null; companyId?: string | null } | undefined,
  permission: string,
) {
  if (!actor?.id || !actor.membershipId || !actor.companyId) throw authorityError("Active company membership required", 403);
  const membership = await db.companyMembership.findFirst({
    where: {
      id: actor.membershipId, userId: actor.id, companyId: actor.companyId, status: "active",
      company: { isActive: true, type: "company" },
    },
    select: {
      companyId: true,
      scopes: { select: { scopeType: true, scopeRefId: true } },
      roles: { select: { role: { select: {
        companyId: true, isSystem: true,
        rolePermissions: { select: { permission: { select: { key: true } } } },
      } } } },
    },
  });
  if (!membership || !membership.roles.some(({ role }) =>
    (role.companyId === membership.companyId || (role.companyId === null && role.isSystem)) &&
    role.rolePermissions.some(({ permission: item }) => item.key === permission),
  )) throw authorityError("Company permission required", 403);
  return membership;
}

export function hasCompanyScope(membership: { companyId: string; scopes: Array<{ scopeType: string; scopeRefId: string }> }) {
  return membership.scopes.some((scope) => scope.scopeType === "company" && scope.scopeRefId === membership.companyId);
}
