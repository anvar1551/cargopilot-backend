"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const prismaClient_1 = __importDefault(require("../config/prismaClient"));
const permission_registry_1 = require("../modules/identity-access/permission-registry");
const ROOT_COMPANY_CODE = "CP_ROOT";
const SUPER_ADMIN_ROLE_CODE = String(process.env.ERP_SUPER_ADMIN_ROLE_CODE ?? "super_admin")
    .trim()
    .toLowerCase();
const ERP_OWNER_EMAIL = String(process.env.ERP_OWNER_EMAIL ?? "").trim().toLowerCase();
const ERP_OWNER_PASSWORD = String(process.env.ERP_OWNER_PASSWORD ?? "").trim();
const ERP_OWNER_NAME = String(process.env.ERP_OWNER_NAME ?? "Super Admin").trim();
async function ensureRootCompany() {
    const existing = await prismaClient_1.default.organization.findFirst({
        where: { code: ROOT_COMPANY_CODE, type: "company" },
        select: { id: true },
    });
    if (existing)
        return existing.id;
    const created = await prismaClient_1.default.organization.create({
        data: { code: ROOT_COMPANY_CODE, name: "CargoPilot Root", type: "company", isActive: true },
        select: { id: true },
    });
    return created.id;
}
async function ensurePermissions() {
    for (const permission of permission_registry_1.SYSTEM_PERMISSIONS) {
        await prismaClient_1.default.permission.upsert({
            where: { key: permission.key },
            create: permission,
            update: permission,
        });
    }
}
async function ensureSuperAdminRole(companyId) {
    let role = await prismaClient_1.default.role.findFirst({
        where: { companyId: null, code: SUPER_ADMIN_ROLE_CODE },
        select: { id: true },
    });
    if (!role) {
        role = await prismaClient_1.default.role.create({
            data: {
                companyId: null,
                code: SUPER_ADMIN_ROLE_CODE,
                name: "Super Admin",
                isSystem: true,
                isOwnerRole: true,
            },
            select: { id: true },
        });
    }
    const permissions = await prismaClient_1.default.permission.findMany({ select: { id: true } });
    for (const permission of permissions) {
        await prismaClient_1.default.rolePermission.upsert({
            where: {
                roleId_permissionId: { roleId: role.id, permissionId: permission.id },
            },
            create: { roleId: role.id, permissionId: permission.id },
            update: {},
        });
    }
    return role.id;
}
async function ensureOwnerUser() {
    if (!ERP_OWNER_EMAIL)
        throw new Error("ERP_OWNER_EMAIL is required");
    const existing = await prismaClient_1.default.user.findUnique({
        where: { email: ERP_OWNER_EMAIL },
        select: { id: true },
    });
    if (existing)
        return existing.id;
    if (!ERP_OWNER_PASSWORD) {
        throw new Error("ERP_OWNER_PASSWORD is required to create ERP owner");
    }
    const password = await bcryptjs_1.default.hash(ERP_OWNER_PASSWORD, 10);
    const created = await prismaClient_1.default.user.create({
        data: { name: ERP_OWNER_NAME, email: ERP_OWNER_EMAIL, password },
        select: { id: true },
    });
    return created.id;
}
async function bindOwnerToCompany(args) {
    const membership = await prismaClient_1.default.companyMembership.upsert({
        where: { userId_companyId: { userId: args.userId, companyId: args.companyId } },
        create: { userId: args.userId, companyId: args.companyId, status: "active" },
        update: { status: "active" },
        select: { id: true },
    });
    await prismaClient_1.default.membershipRole.upsert({
        where: {
            membershipId_roleId: { membershipId: membership.id, roleId: args.roleId },
        },
        create: { membershipId: membership.id, roleId: args.roleId },
        update: {},
    });
    await prismaClient_1.default.membershipScope.upsert({
        where: {
            membershipId_scopeType_scopeRefId: {
                membershipId: membership.id,
                scopeType: "company",
                scopeRefId: args.companyId,
            },
        },
        create: { membershipId: membership.id, scopeType: "company", scopeRefId: args.companyId },
        update: {},
    });
}
async function main() {
    const companyId = await ensureRootCompany();
    await ensurePermissions();
    const roleId = await ensureSuperAdminRole(companyId);
    const userId = await ensureOwnerUser();
    await bindOwnerToCompany({ userId, companyId, roleId });
    console.log(`[erp-bootstrap] done company=${companyId} owner=${userId} role=${roleId}`);
}
main()
    .catch((err) => {
    console.error("[erp-bootstrap] failed", err);
    process.exitCode = 1;
})
    .finally(async () => {
    await prismaClient_1.default.$disconnect().catch(() => undefined);
});
