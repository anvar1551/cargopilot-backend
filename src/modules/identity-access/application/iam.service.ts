import prisma from "../../../config/prismaClient";
import { SYSTEM_PERMISSIONS } from "../permission-registry";
import type { AppUser } from "../../../types/app-user";
import { requireIdentityManagementContext, rejectAdministrativeMutation } from "./managementAccess";


export async function seedSystemPermissions() {
  for (const permission of SYSTEM_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: permission.key },
      create: {
        key: permission.key,
        resource: permission.resource,
        action: permission.action,
        description: permission.description,
      },
      update: {
        resource: permission.resource,
        action: permission.action,
        description: permission.description,
      },
    });
  }

  // Catalog maintenance does not delegate new permissions to existing roles.
}

export async function listPermissions(actor: AppUser) {
  await requireIdentityManagementContext(actor, "roles.read");
  const rows = await prisma.permission.findMany({
    orderBy: [{ resource: "asc" }, { action: "asc" }, { key: "asc" }],
    select: {
      id: true,
      key: true,
      resource: true,
      action: true,
      description: true,
    },
  });
  return rows;
}

export async function listRolesForCompany(args: {
  actor: AppUser;
  includeSystem?: boolean;
}) {
  const context = await requireIdentityManagementContext(args.actor, "roles.read");
  const roles = await prisma.role.findMany({
    where: { companyId: context.companyId, company: { is: { tenantId: context.tenantId, isActive: true } }, isSystem: false },
    orderBy: [{ isSystem: "desc" }, { code: "asc" }],
    select: {
      id: true,
      code: true,
      name: true,
      isSystem: true,
      isOwnerRole: true,
      rolePermissions: {
        select: {
          permission: {
            select: { id: true, key: true, resource: true, action: true },
          },
        },
      },
    },
  });

  return roles.map((role) => ({
    id: role.id,
    code: role.code,
    name: role.name,
    isSystem: role.isSystem,
    isOwnerRole: role.isOwnerRole,
    permissions: role.rolePermissions.map((item) => item.permission),
  }));
}

export async function createRoleForCompany(args: {
  companyId: string;
  code?: string | null;
  name: string;
  permissionKeys: string[];
  isOwnerRole?: boolean;
}) {
  rejectAdministrativeMutation();
}
