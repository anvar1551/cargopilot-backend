import prisma from "../../../config/prismaClient";
import { SYSTEM_PERMISSIONS } from "../permission-registry";

function normalizeCode(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

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

  // Keep system owner roles (e.g. super_admin) in sync when new permissions are introduced.
  const [systemOwnerRoles, permissions] = await prisma.$transaction([
    prisma.role.findMany({
      where: { isSystem: true, isOwnerRole: true },
      select: { id: true },
    }),
    prisma.permission.findMany({ select: { id: true } }),
  ]);

  for (const role of systemOwnerRoles) {
    for (const permission of permissions) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: role.id,
            permissionId: permission.id,
          },
        },
        create: {
          roleId: role.id,
          permissionId: permission.id,
        },
        update: {},
      });
    }
  }
}

export async function listPermissions() {
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
  companyId: string;
  includeSystem?: boolean;
}) {
  const roles = await prisma.role.findMany({
    where: args.includeSystem
      ? { OR: [{ companyId: args.companyId }, { companyId: null }] }
      : { companyId: args.companyId },
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
  const name = String(args.name || "").trim();
  if (!name) throw new Error("name is required");

  const permissionKeys = Array.from(
    new Set(args.permissionKeys.map((item) => String(item || "").trim()).filter(Boolean)),
  );
  if (permissionKeys.length === 0) throw new Error("permissionKeys is required");

  const permissions = await prisma.permission.findMany({
    where: { key: { in: permissionKeys } },
    select: { id: true, key: true },
  });
  const permissionIdByKey = new Map(permissions.map((item) => [item.key, item.id] as const));
  for (const key of permissionKeys) {
    if (!permissionIdByKey.has(key)) {
      throw new Error(`Unknown permission: ${key}`);
    }
  }

  const code = normalizeCode(args.code || name);
  const role = await prisma.role.create({
    data: {
      companyId: args.companyId,
      code,
      name,
      isSystem: false,
      isOwnerRole: Boolean(args.isOwnerRole),
    },
    select: { id: true, code: true, name: true, isSystem: true, isOwnerRole: true },
  });

  for (const key of permissionKeys) {
    const permissionId = permissionIdByKey.get(key);
    if (!permissionId) continue;
    await prisma.rolePermission.create({
      data: {
        roleId: role.id,
        permissionId,
      },
    });
  }

  return role;
}
