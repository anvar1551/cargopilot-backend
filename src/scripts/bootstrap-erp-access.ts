import "dotenv/config";
import bcrypt from "bcryptjs";
import prisma from "../config/prismaClient";
import { SYSTEM_PERMISSIONS } from "../modules/identity-access/permission-registry";

const ROOT_COMPANY_CODE = "CP_ROOT";
const SUPER_ADMIN_ROLE_CODE = String(process.env.ERP_SUPER_ADMIN_ROLE_CODE ?? "super_admin")
  .trim()
  .toLowerCase();
const ERP_OWNER_EMAIL = String(process.env.ERP_OWNER_EMAIL ?? "").trim().toLowerCase();
const ERP_OWNER_PASSWORD = String(process.env.ERP_OWNER_PASSWORD ?? "").trim();
const ERP_OWNER_NAME = String(process.env.ERP_OWNER_NAME ?? "Super Admin").trim();

async function ensureRootCompany() {
  const existing = await prisma.organization.findFirst({
    where: { code: ROOT_COMPANY_CODE, type: "company" },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await prisma.organization.create({
    data: { code: ROOT_COMPANY_CODE, name: "CargoPilot Root", type: "company", isActive: true },
    select: { id: true },
  });
  return created.id;
}

async function ensurePermissions() {
  for (const permission of SYSTEM_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: permission.key },
      create: permission,
      update: permission,
    });
  }
}

async function ensureSuperAdminRole(companyId: string) {
  let role = await prisma.role.findFirst({
    where: { companyId: null, code: SUPER_ADMIN_ROLE_CODE },
    select: { id: true },
  });
  if (!role) {
    role = await prisma.role.create({
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

  const permissions = await prisma.permission.findMany({ select: { id: true } });
  for (const permission of permissions) {
    await prisma.rolePermission.upsert({
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
  if (!ERP_OWNER_EMAIL) throw new Error("ERP_OWNER_EMAIL is required");
  const existing = await prisma.user.findUnique({
    where: { email: ERP_OWNER_EMAIL },
    select: { id: true },
  });
  if (existing) return existing.id;
  if (!ERP_OWNER_PASSWORD) {
    throw new Error("ERP_OWNER_PASSWORD is required to create ERP owner");
  }
  const password = await bcrypt.hash(ERP_OWNER_PASSWORD, 10);
  const created = await prisma.user.create({
    data: { name: ERP_OWNER_NAME, email: ERP_OWNER_EMAIL, password },
    select: { id: true },
  });
  return created.id;
}

async function bindOwnerToCompany(args: { userId: string; companyId: string; roleId: string }) {
  const membership = await prisma.companyMembership.upsert({
    where: { userId_companyId: { userId: args.userId, companyId: args.companyId } },
    create: { userId: args.userId, companyId: args.companyId, status: "active" },
    update: { status: "active" },
    select: { id: true },
  });

  await prisma.membershipRole.upsert({
    where: {
      membershipId_roleId: { membershipId: membership.id, roleId: args.roleId },
    },
    create: { membershipId: membership.id, roleId: args.roleId },
    update: {},
  });

  await prisma.membershipScope.upsert({
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
    await prisma.$disconnect().catch(() => undefined);
  });
