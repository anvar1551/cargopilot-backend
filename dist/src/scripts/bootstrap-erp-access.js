"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const client_1 = require("@prisma/client");
const prismaClient_1 = __importDefault(require("../config/prismaClient"));
const identity_access_1 = require("../modules/identity-access");
const ROOT_ORG_CODE = "CP_ROOT";
const MANAGER_ROLE_CODE = "manager_global";
const DRIVER_ROLE_CODE = "driver_ops";
const WAREHOUSE_ROLE_CODE = "warehouse_ops";
const CUSTOMER_ROLE_CODE = "customer_portal";
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
    {
        code: "users.manage",
        resource: "users",
        action: "manage",
        description: "Create/list/delete users and assign operational access",
    },
    {
        code: "drivers.read",
        resource: "drivers",
        action: "read",
        description: "Read driver roster and operational state",
    },
    {
        code: "drivers.manage",
        resource: "drivers",
        action: "manage",
        description: "Update driver profile, warehouse access, and operational settings",
    },
    {
        code: "drivers.telemetry",
        resource: "drivers",
        action: "telemetry",
        description: "Publish location/presence and read driver presence data",
    },
    {
        code: "customers.read",
        resource: "customers",
        action: "read",
        description: "Read customer entities in scoped context",
    },
    {
        code: "customers.write",
        resource: "customers",
        action: "write",
        description: "Create/update customer entities in scoped context",
    },
    {
        code: "payments.providers.read",
        resource: "payments",
        action: "providers.read",
        description: "Read configured payment providers in scoped context",
    },
    {
        code: "payments.providers.manage",
        resource: "payments",
        action: "providers.manage",
        description: "Create/update provider credentials and payment settings",
    },
    {
        code: "payments.intents.create",
        resource: "payments",
        action: "intents.create",
        description: "Create payment intents for scoped orders",
    },
    {
        code: "payments.intents.read",
        resource: "payments",
        action: "intents.read",
        description: "Read payment intents and attempts in scope",
    },
    {
        code: "payments.refunds.create",
        resource: "payments",
        action: "refunds.create",
        description: "Create payment refunds for scoped intents",
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
async function ensureSystemRole(args) {
    let role = await prismaClient_1.default.accessRole.findFirst({
        where: { code: args.code, isSystem: true },
        select: { id: true },
    });
    if (!role) {
        role = await prismaClient_1.default.accessRole.create({
            data: {
                code: args.code,
                name: args.name,
                isSystem: true,
            },
            select: { id: true },
        });
    }
    for (const permissionId of args.permissionIds) {
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
    for (const policy of args.scopePolicies) {
        await prismaClient_1.default.dataScopePolicy.upsert({
            where: {
                roleId_resource: {
                    roleId: role.id,
                    resource: policy.resource,
                },
            },
            create: {
                roleId: role.id,
                resource: policy.resource,
                scopeType: policy.scopeType,
            },
            update: {
                scopeType: policy.scopeType,
            },
        });
    }
    return role.id;
}
async function bindExistingUsersByRole(args) {
    const users = await prismaClient_1.default.user.findMany({
        where: { role: args.appRole },
        select: { id: true, homeOrgId: true },
    });
    for (const user of users) {
        if (!user.homeOrgId) {
            await prismaClient_1.default.user.update({
                where: { id: user.id },
                data: { homeOrgId: args.rootOrgId },
            });
        }
        await prismaClient_1.default.userRoleBinding.upsert({
            where: {
                userId_roleId_orgId: {
                    userId: user.id,
                    roleId: args.roleId,
                    orgId: args.rootOrgId,
                },
            },
            create: {
                userId: user.id,
                roleId: args.roleId,
                orgId: args.rootOrgId,
            },
            update: {},
        });
    }
    return users.length;
}
async function main() {
    console.log("[erp-bootstrap] starting");
    const rootOrgId = await ensureRootOrganization();
    const permissions = await ensurePermissions();
    const permissionByCode = new Map(permissions.map((item) => [item.code, item.id]));
    const mapPermissionIds = (codes) => codes
        .map((code) => permissionByCode.get(code))
        .filter((value) => Boolean(value));
    const managerRoleId = await ensureSystemRole({
        code: MANAGER_ROLE_CODE,
        name: "Manager (Global)",
        permissionIds: mapPermissionIds([
            "orders.read",
            "orders.write",
            "orders.export",
            "support.read",
            "support.create",
            "support.update",
            "pricing.read",
            "pricing.write",
            "users.manage",
            "drivers.read",
            "drivers.manage",
            "drivers.telemetry",
            "customers.read",
            "customers.write",
            "payments.providers.read",
            "payments.providers.manage",
            "payments.intents.create",
            "payments.intents.read",
            "payments.refunds.create",
        ]),
        scopePolicies: [
            { resource: client_1.ScopeResource.orders, scopeType: client_1.ScopeType.global },
            { resource: client_1.ScopeResource.support, scopeType: client_1.ScopeType.global },
            { resource: client_1.ScopeResource.drivers, scopeType: client_1.ScopeType.global },
            { resource: client_1.ScopeResource.customers, scopeType: client_1.ScopeType.global },
            { resource: client_1.ScopeResource.payments, scopeType: client_1.ScopeType.global },
        ],
    });
    const driverRoleId = await ensureSystemRole({
        code: DRIVER_ROLE_CODE,
        name: "Driver (Operations)",
        permissionIds: mapPermissionIds([
            "orders.read",
            "orders.write",
            "support.read",
            "support.create",
            "support.update",
            "drivers.telemetry",
        ]),
        scopePolicies: [
            { resource: client_1.ScopeResource.orders, scopeType: client_1.ScopeType.assigned },
            { resource: client_1.ScopeResource.support, scopeType: client_1.ScopeType.own },
            { resource: client_1.ScopeResource.drivers, scopeType: client_1.ScopeType.own },
        ],
    });
    const warehouseRoleId = await ensureSystemRole({
        code: WAREHOUSE_ROLE_CODE,
        name: "Warehouse (Operations)",
        permissionIds: mapPermissionIds([
            "orders.read",
            "orders.write",
            "support.read",
            "support.create",
            "support.update",
            "drivers.read",
        ]),
        scopePolicies: [
            { resource: client_1.ScopeResource.orders, scopeType: client_1.ScopeType.organization },
            { resource: client_1.ScopeResource.support, scopeType: client_1.ScopeType.organization },
            { resource: client_1.ScopeResource.drivers, scopeType: client_1.ScopeType.organization },
        ],
    });
    const customerRoleId = await ensureSystemRole({
        code: CUSTOMER_ROLE_CODE,
        name: "Customer (Portal)",
        permissionIds: mapPermissionIds([
            "orders.read",
            "orders.write",
            "support.read",
            "support.create",
            "customers.read",
            "payments.intents.read",
        ]),
        scopePolicies: [
            { resource: client_1.ScopeResource.orders, scopeType: client_1.ScopeType.own },
            { resource: client_1.ScopeResource.support, scopeType: client_1.ScopeType.own },
            { resource: client_1.ScopeResource.customers, scopeType: client_1.ScopeType.own },
            { resource: client_1.ScopeResource.payments, scopeType: client_1.ScopeType.own },
        ],
    });
    const [boundManagers, boundDrivers, boundWarehouses, boundCustomers] = await Promise.all([
        bindExistingUsersByRole({ appRole: identity_access_1.ROLE_MANAGER, roleId: managerRoleId, rootOrgId }),
        bindExistingUsersByRole({ appRole: identity_access_1.ROLE_DRIVER, roleId: driverRoleId, rootOrgId }),
        bindExistingUsersByRole({ appRole: identity_access_1.ROLE_WAREHOUSE, roleId: warehouseRoleId, rootOrgId }),
        bindExistingUsersByRole({ appRole: identity_access_1.ROLE_CUSTOMER, roleId: customerRoleId, rootOrgId }),
    ]);
    console.log(`[erp-bootstrap] done rootOrg=${rootOrgId} managerRole=${managerRoleId} driverRole=${driverRoleId} warehouseRole=${warehouseRoleId} customerRole=${customerRoleId} managersBound=${boundManagers} driversBound=${boundDrivers} warehousesBound=${boundWarehouses} customersBound=${boundCustomers}`);
}
main()
    .catch((error) => {
    console.error("[erp-bootstrap] failed", error);
    process.exitCode = 1;
})
    .finally(async () => {
    await prismaClient_1.default.$disconnect().catch(() => undefined);
});
