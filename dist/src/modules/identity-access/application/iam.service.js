"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.seedSystemPermissions = seedSystemPermissions;
exports.listPermissions = listPermissions;
exports.listRolesForCompany = listRolesForCompany;
exports.createRoleForCompany = createRoleForCompany;
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const permission_registry_1 = require("../permission-registry");
function normalizeCode(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "_");
}
async function seedSystemPermissions() {
    for (const permission of permission_registry_1.SYSTEM_PERMISSIONS) {
        await prismaClient_1.default.permission.upsert({
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
    const [systemOwnerRoles, permissions] = await prismaClient_1.default.$transaction([
        prismaClient_1.default.role.findMany({
            where: { isSystem: true, isOwnerRole: true },
            select: { id: true },
        }),
        prismaClient_1.default.permission.findMany({ select: { id: true } }),
    ]);
    for (const role of systemOwnerRoles) {
        for (const permission of permissions) {
            await prismaClient_1.default.rolePermission.upsert({
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
async function listPermissions() {
    const rows = await prismaClient_1.default.permission.findMany({
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
async function listRolesForCompany(args) {
    const roles = await prismaClient_1.default.role.findMany({
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
async function createRoleForCompany(args) {
    const name = String(args.name || "").trim();
    if (!name)
        throw new Error("name is required");
    const permissionKeys = Array.from(new Set(args.permissionKeys.map((item) => String(item || "").trim()).filter(Boolean)));
    if (permissionKeys.length === 0)
        throw new Error("permissionKeys is required");
    const permissions = await prismaClient_1.default.permission.findMany({
        where: { key: { in: permissionKeys } },
        select: { id: true, key: true },
    });
    const permissionIdByKey = new Map(permissions.map((item) => [item.key, item.id]));
    for (const key of permissionKeys) {
        if (!permissionIdByKey.has(key)) {
            throw new Error(`Unknown permission: ${key}`);
        }
    }
    const code = normalizeCode(args.code || name);
    const role = await prismaClient_1.default.role.create({
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
        if (!permissionId)
            continue;
        await prismaClient_1.default.rolePermission.create({
            data: {
                roleId: role.id,
                permissionId,
            },
        });
    }
    return role;
}
