"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const prismaClient_1 = __importDefault(require("../config/prismaClient"));
const ROOT_ORG_CODE = "CP_ROOT";
const MANAGER_ROLE_CODE = "manager_global";
const permissionSeeds = [
    {
        code: "orders.read",
        resource: "orders",
        action: "read",
        description: "Read order list/detail in scoped context",
    },
    {
        code: "orders.write",
        resource: "orders",
        action: "write",
        description: "Create/update scoped order operational data",
    },
    {
        code: "orders.export",
        resource: "orders",
        action: "export",
        description: "Export scoped orders to CSV and operational extracts",
    },
    {
        code: "support.read",
        resource: "support",
        action: "read",
        description: "Read support tickets in scoped context",
    },
    {
        code: "support.create",
        resource: "support",
        action: "create",
        description: "Create support tickets",
    },
    {
        code: "support.update",
        resource: "support",
        action: "update",
        description: "Update support ticket workflow/messages/notes",
    },
    {
        code: "pricing.read",
        resource: "pricing",
        action: "read",
        description: "Read pricing regions, SLA rules/policy, tariffs, and quote views",
    },
    {
        code: "pricing.write",
        resource: "pricing",
        action: "write",
        description: "Create/update pricing regions, SLA rules/policy, zone matrix, and tariffs",
    },
];
async function ensureRootOrganization() {
    const existing = await prismaClient_1.default.organization.findFirst({
        where: { code: ROOT_ORG_CODE },
        select: { id: true },
    });
    if (existing)
        return existing.id;
    const created = await prismaClient_1.default.organization.create({
        data: {
            name: "CargoPilot Root",
            code: ROOT_ORG_CODE,
            type: "company",
            isActive: true,
        },
        select: { id: true },
    });
    return created.id;
}
async function ensurePermissions() {
    const permissions = [];
    for (const seed of permissionSeeds) {
        const permission = await prismaClient_1.default.accessPermission.upsert({
            where: { code: seed.code },
            create: {
                code: seed.code,
                resource: seed.resource,
                action: seed.action,
                description: seed.description,
            },
            update: {
                resource: seed.resource,
                action: seed.action,
                description: seed.description,
            },
            select: { id: true, code: true },
        });
        permissions.push(permission);
    }
    return permissions;
}
async function ensureManagerRole(permissionIds) {
    let role = await prismaClient_1.default.accessRole.findFirst({
        where: { code: MANAGER_ROLE_CODE, isSystem: true },
        select: { id: true },
    });
    if (!role) {
        role = await prismaClient_1.default.accessRole.create({
            data: {
                code: MANAGER_ROLE_CODE,
                name: "Manager (Global)",
                isSystem: true,
            },
            select: { id: true },
        });
    }
    for (const permissionId of permissionIds) {
        await prismaClient_1.default.rolePermission.upsert({
            where: {
                roleId_permissionId: {
                    roleId: role.id,
                    permissionId,
                },
            },
            create: {
                roleId: role.id,
                permissionId,
            },
            update: {},
        });
    }
    await prismaClient_1.default.dataScopePolicy.upsert({
        where: {
            roleId_resource: {
                roleId: role.id,
                resource: client_1.ScopeResource.orders,
            },
        },
        create: {
            roleId: role.id,
            resource: client_1.ScopeResource.orders,
            scopeType: client_1.ScopeType.global,
        },
        update: {
            scopeType: client_1.ScopeType.global,
        },
    });
    await prismaClient_1.default.dataScopePolicy.upsert({
        where: {
            roleId_resource: {
                roleId: role.id,
                resource: client_1.ScopeResource.support,
            },
        },
        create: {
            roleId: role.id,
            resource: client_1.ScopeResource.support,
            scopeType: client_1.ScopeType.global,
        },
        update: {
            scopeType: client_1.ScopeType.global,
        },
    });
    return role.id;
}
async function bindExistingManagers(roleId, rootOrgId) {
    const managers = await prismaClient_1.default.user.findMany({
        where: { role: client_1.AppRole.manager },
        select: { id: true, homeOrgId: true },
    });
    for (const manager of managers) {
        if (!manager.homeOrgId) {
            await prismaClient_1.default.user.update({
                where: { id: manager.id },
                data: { homeOrgId: rootOrgId },
            });
        }
        await prismaClient_1.default.userRoleBinding.upsert({
            where: {
                userId_roleId_orgId: {
                    userId: manager.id,
                    roleId,
                    orgId: rootOrgId,
                },
            },
            create: {
                userId: manager.id,
                roleId,
                orgId: rootOrgId,
            },
            update: {},
        });
    }
    return managers.length;
}
async function main() {
    console.log("[erp-bootstrap] starting");
    const rootOrgId = await ensureRootOrganization();
    const permissions = await ensurePermissions();
    const managerRoleId = await ensureManagerRole(permissions.map((item) => item.id));
    const boundCount = await bindExistingManagers(managerRoleId, rootOrgId);
    console.log(`[erp-bootstrap] done rootOrg=${rootOrgId} managerRole=${managerRoleId} managersBound=${boundCount}`);
}
main()
    .catch((error) => {
    console.error("[erp-bootstrap] failed", error);
    process.exitCode = 1;
})
    .finally(async () => {
    await prismaClient_1.default.$disconnect().catch(() => undefined);
});
