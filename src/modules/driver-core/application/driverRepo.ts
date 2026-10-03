import type { AppUser } from "../../../types/app-user";
import { z } from "zod";
import prisma from "../../../config/prismaClient";
import { loadAccessSnapshot } from "../../identity-access/access-control";
import { hasCompanyScope, requireTenantBoundOrderCompanyAuthority } from "../../orders-core/domain/company-authority";

export async function requireDriverManagement(context: AppUser | undefined) {
  const membership = await requireTenantBoundOrderCompanyAuthority(prisma, context, "drivers.manage");
  if (!membership.tenantId) throw Object.assign(new Error("Tenant-owned membership required"), { statusCode: 403 });
  const selected = context && await loadAccessSnapshot({
    userId: context.id, membershipId: context.membershipId, tenantId: context.tenantId,
    tenantMembershipId: context.tenantMembershipId, companyId: context.companyId,
    companyMembershipId: context.companyMembershipId, requireFresh: true,
  });
  if (!selected || !selected.permissionCodes.includes("drivers.manage")) throw Object.assign(new Error("Current selected context required"), { statusCode: 403 });
  if (!hasCompanyScope(membership)) throw Object.assign(new Error("Selected company scope required"), { statusCode: 403 });
  return { ...membership, tenantId: membership.tenantId };
}
const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().uuid().optional() }).strict();

/** Enumerates eligible selected-company memberships, never user-global driver classifications. */
export const listAllDrivers = async (context: AppUser, query: unknown = {}) => {
  const membership = await requireDriverManagement(context);
  const input = querySchema.parse(query);
  const where = {
    tenantId: membership.tenantId, companyId: membership.companyId, status: "active" as const,
    tenantMembershipId: { not: null },
    tenant: { status: "active" as const }, company: { tenantId: membership.tenantId, isActive: true, type: "company" as const },
    tenantMembership: { tenantId: membership.tenantId, status: "active" as const },
    roles: { some: { role: {
      OR: [{ companyId: membership.companyId }, { companyId: null, isSystem: true }],
      rolePermissions: { some: { permission: { key: "drivers.telemetry" } } },
    } } },
  };
  if (input.cursor && !await prisma.companyMembership.findFirst({ where: { AND: [where, { id: input.cursor }] }, select: { id: true } })) {
    throw Object.assign(new Error("Driver cursor not found"), { statusCode: 404 });
  }
  const rows = await prisma.companyMembership.findMany({
    where: { AND: [where, ...(input.cursor ? [{ id: { gt: input.cursor } }] : [])] },
    take: input.limit, orderBy: { id: "asc" },
    select: { id: true, userId: true, tenantMembership: { select: { userId: true } }, user: { select: { id: true, name: true, email: true } } },
  });
  return rows.filter(row => row.tenantMembership?.userId === row.userId && row.user.id === row.userId).map(row => ({
    id: row.user.id, companyMembershipId: row.id, name: row.user.name, email: row.user.email,
    role: "driver", warehouseId: null, warehouseIds: [], driverType: null, isPartial: true,
  }));
};
