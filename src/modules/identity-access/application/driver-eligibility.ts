import type { Prisma } from "@prisma/client";
import { DRIVER_PROFILES, driverProfileSchema, profileDriverType } from "./driver-profiles";

/** Accepted classification belongs to one company membership, never the shared User.
 * Transactional writers take SHARE before using it; replacement/revocation take UPDATE.
 * The lock survives through the caller's transaction, including assignment/custody writes. */
export async function requireAcceptedDriver(tx: Prisma.TransactionClient, context: { tenantId: string; companyId: string },
  membershipId: string, type?: "local" | "linehaul", permission?: string) {
  await tx.$queryRaw`SELECT "membershipId" FROM "CompanyDriverEligibility" WHERE "membershipId"=${membershipId}::uuid FOR SHARE`;
  const m = await tx.companyMembership.findFirst({ where: { id: membershipId, tenantId: context.tenantId,
    companyId: context.companyId, status: "active", company: { tenantId: context.tenantId, isActive: true, type: "company" },
    tenant: { status: "active" }, OR: [{ branchId: null }, { branch: { tenantId: context.tenantId, isActive: true } }] },
    include: { tenantMembership: true, driverEligibility: { include: { acceptedAction: { select: { action: true, result: true } } } }, scopes: true,
      roles: { include: { role: { include: { rolePermissions: { include: { permission: true } } } } } } } });
  const e = m?.driverEligibility, tm = m?.tenantMembership;
  const profile = driverProfileSchema.safeParse(e?.profileRevision);
  const expected = profile.success ? [...DRIVER_PROFILES[profile.data]].sort() : [];
  const role = m?.roles[0]?.role;
  const actual = role?.rolePermissions.map(p => p.permission.key).sort() ?? [];
  const accepted = e?.acceptedAction.result as { companyMembershipId?: string; profileRevision?: string } | undefined;
  if (!m || !e?.enabled || !tm || tm.status !== "active" || tm.id !== m.tenantMembershipId ||
      tm.userId !== m.userId || tm.tenantId !== context.tenantId || e.userId !== m.userId ||
      e.tenantMembershipId !== tm.id || e.tenantId !== context.tenantId || e.companyId !== context.companyId ||
      !e.acceptedAction || !["accept", "grant"].includes(e.acceptedAction.action) || accepted?.companyMembershipId !== m.id || accepted.profileRevision !== e.profileRevision ||
      !profile.success || e.driverType !== profileDriverType(profile.data) || (type && e.driverType !== type) ||
      m.scopes.length || m.roles.length !== 1 || role?.id !== e.roleId || role.companyId !== context.companyId ||
      role.isSystem || role.isOwnerRole || role.code !== profile.data || JSON.stringify(actual) !== JSON.stringify(expected) ||
      (permission && !expected.includes(permission))) {
    throw Object.assign(new Error("Eligible exact driver membership required"), { statusCode: 403 });
  }
  return { id: m.id, userId: m.userId, tenantMembershipId: tm.id, profileRevision: profile.data,
    driverType: e.driverType as "local" | "linehaul" };
}
