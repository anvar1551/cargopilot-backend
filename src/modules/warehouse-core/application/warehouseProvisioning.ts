import { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { AppUser } from "../../../types/app-user";
import { companyMembershipPrimitives } from "../../identity-access/application/company-delegation";
import { lockCredentialUser } from "../../identity-access/application/credential-lock";
import { authenticateControlledOperatorPermit } from "../../identity-access/application/tenant-onboarding";
import { delegationFingerprint, operationIdSchema, reasonSchema } from "../../identity-access/application/operational-profiles";
import { clearIdentityAccessCacheForUser } from "../../identity-access/access-control";
import { WAREHOUSE_SELECT } from "./warehouseProjection";
import { requireWarehouseAccess, warehouseAccessError } from "./warehouseAccess";
export const WAREHOUSE_PROVISIONING_REVISION = "warehouse-provisioning.v1";
const { context, member, keys, agrees, operationLock, staticRole, revokeContextSessions } = companyMembershipPrimitives;
const options = { maxWait: 3000, timeout: 15000 };
const coordinate = (limit: number) => z.number().finite().min(-limit).max(limit).nullable().optional().transform(v => v ?? null);
export const warehouseCreationSchema = z.object({ operationId: operationIdSchema,
  name: z.string().trim().min(1).max(160).regex(/^[^\u0000-\u001f\u007f]+$/),
  location: z.string().trim().min(1).max(500).regex(/^[^\u0000-\u001f\u007f]+$/),
  type: z.enum(["warehouse", "pickup_point"]).default("warehouse"),
  region: z.string().trim().max(160).regex(/^[^\u0000-\u001f\u007f]*$/).nullable().optional().transform(v => v || null),
  latitude: coordinate(90), longitude: coordinate(180) }).strict();
async function lockOwnership(tx: Prisma.TransactionClient, m: Awaited<ReturnType<typeof member>>) {
  await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id=${m.tenantId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "Organization" WHERE id=${m.companyId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "TenantMembership" WHERE id=${m.tenantMembershipId}::uuid FOR SHARE`;
  return member(tx, m.id);
}
async function receipt(tx: Prisma.TransactionClient, operationId: string, action: string, fingerprint: string, c: ReturnType<typeof context>) {
  const p = (await tx.$queryRaw<any[]>`SELECT * FROM "WarehouseProvisioningAction" WHERE "operationId"=${operationId}::uuid`)[0];
  if (p && (p.action !== action || p.fingerprint !== fingerprint || p.membershipId !== c.companyMembershipId || p.userId !== c.id || p.tenantMembershipId !== c.tenantMembershipId || p.tenantId !== c.tenantId || p.companyId !== c.companyId)) throw warehouseAccessError("Warehouse operation conflict", 409);
  return p;
}
async function record(tx: Prisma.TransactionClient, c: ReturnType<typeof context>, operationId: string, action: string, fingerprint: string, result: object, reason: string, warehouseId: string | null = null, keyFingerprint: string | null = null) {
  await tx.$executeRaw`INSERT INTO "WarehouseProvisioningAction" ("operationId","tenantId","companyId","membershipId","userId","tenantMembershipId",action,fingerprint,"operatorId","operatorKeyFingerprint","warehouseId",reason,result)
    VALUES (${operationId}::uuid,${c.tenantId}::uuid,${c.companyId}::uuid,${c.companyMembershipId}::uuid,${c.id}::uuid,${c.tenantMembershipId}::uuid,${action},${fingerprint},${keyFingerprint ? "cargopilot-bootstrap-owner" : null},${keyFingerprint},${warehouseId}::uuid,${reason},${JSON.stringify(result)}::jsonb)`;
}
const ownerSchema = z.object({ operationId: operationIdSchema, membershipId: operationIdSchema,
  action: z.enum(["operator-authorize", "operator-revoke"]), profileRevision: z.literal(WAREHOUSE_PROVISIONING_REVISION), reason: reasonSchema }).strict();
/** Internal owner mechanism, never a public route or tenant-delegation permission. */
export async function authorizeWarehouseProvisioner(db: PrismaClient, args: { intent: unknown; permit: unknown; signature: string }) {
  const v = ownerSchema.parse(args.intent), fingerprint = delegationFingerprint("warehouse-operator-authority", v);
  const verify = () => authenticateControlledOperatorPermit(args.permit, args.signature, v.operationId, fingerprint, WAREHOUSE_PROVISIONING_REVISION);
  verify(); const target = await db.companyMembership.findUnique({ where: { id: v.membershipId }, select: { userId: true } });
  if (!target) throw warehouseAccessError("Provisioning membership unavailable");
  return db.$transaction(async tx => {
    await lockCredentialUser(tx, target.userId); await operationLock(tx, v.operationId);
    let m = await member(tx, v.membershipId, true); m = await lockOwnership(tx, m);
    const c = { id: m.userId, tenantId: m.tenantId!, companyId: m.companyId, tenantMembershipId: m.tenantMembershipId!, companyMembershipId: m.id };
    verify(); const old = await receipt(tx, v.operationId, v.action, fingerprint, c); if (old) return old.result;
    await tx.$queryRaw`SELECT "membershipId" FROM "WarehouseProvisioningAuthority" WHERE "membershipId"=${m.id}::uuid FOR UPDATE`;
    if (v.action === "operator-authorize") {
      if (m.roles.some(r => r.role.isSystem || r.role.isOwnerRole || r.role.companyId !== m.companyId) || !m.scopes.some(s => s.scopeType === "company" && s.scopeRefId === m.companyId)) throw warehouseAccessError("Explicit company administrator required");
      const role = await staticRole(tx, m.companyId, "warehouse-provisioner.v1", ["warehouse.create"]);
      await tx.membershipRole.upsert({ where: { membershipId_roleId: { membershipId: m.id, roleId: role.id } }, create: { membershipId: m.id, roleId: role.id }, update: {} });
      await tx.$executeRaw`INSERT INTO "WarehouseProvisioningAuthority" ("membershipId","userId","tenantId","companyId","tenantMembershipId","profileRevision","acceptedOperationId")
        VALUES (${m.id}::uuid,${m.userId}::uuid,${m.tenantId}::uuid,${m.companyId}::uuid,${m.tenantMembershipId}::uuid,${WAREHOUSE_PROVISIONING_REVISION},${v.operationId}::uuid)
        ON CONFLICT ("membershipId") DO UPDATE SET enabled=true,"acceptedOperationId"=EXCLUDED."acceptedOperationId"`;
    } else {
      await tx.$executeRaw`UPDATE "WarehouseProvisioningAuthority" SET enabled=false WHERE "membershipId"=${m.id}::uuid`;
      await tx.membershipRole.deleteMany({ where: { membershipId: m.id, role: { companyId: m.companyId, code: "warehouse-provisioner.v1", isSystem: false, isOwnerRole: false } } });
    }
    await revokeContextSessions(tx, m); const accepted = verify(); const result = { companyMembershipId: m.id, enabled: v.action === "operator-authorize", profileRevision: WAREHOUSE_PROVISIONING_REVISION };
    await record(tx, c, v.operationId, v.action, fingerprint, result, v.reason, null, accepted.keyFingerprint); return result;
  }, options).finally(() => clearIdentityAccessCacheForUser(target.userId));
}
export async function createControlledWarehouse(db: PrismaClient, actor: AppUser, input: unknown) {
  const parsed = warehouseCreationSchema.safeParse(input); if (!parsed.success) throw warehouseAccessError("Invalid or unsupported warehouse creation fields", 400);
  const v = parsed.data, c = context(actor); await requireWarehouseAccess(actor, "warehouse.create");
  const fingerprint = delegationFingerprint("warehouse-create", { ...c, ...v });
  return db.$transaction(async tx => {
    await lockCredentialUser(tx, c.id); await operationLock(tx, v.operationId); let m = await member(tx, c.companyMembershipId, true); agrees(m, c); m = await lockOwnership(tx, m);
    const a = (await tx.$queryRaw<any[]>`SELECT a.*,j.action AS "acceptedAction",j.result AS "acceptedResult" FROM "WarehouseProvisioningAuthority" a
      JOIN "WarehouseProvisioningAction" j ON j."operationId"=a."acceptedOperationId" AND j."membershipId"=a."membershipId" AND j."tenantId"=a."tenantId" AND j."companyId"=a."companyId"
      WHERE a."membershipId"=${m.id}::uuid FOR UPDATE OF a`)[0];
    if (!a?.enabled || a.profileRevision !== WAREHOUSE_PROVISIONING_REVISION || a.userId !== c.id || a.tenantId !== c.tenantId || a.companyId !== c.companyId || a.tenantMembershipId !== c.tenantMembershipId || a.acceptedAction !== "operator-authorize" || a.acceptedResult?.companyMembershipId !== m.id || a.acceptedResult?.enabled !== true ||
      !keys(m).includes("warehouse.create") || !m.scopes.some(s => s.scopeType === "company" && s.scopeRefId === c.companyId)) throw warehouseAccessError("Accepted warehouse provisioning authority required");
    const old = await receipt(tx, v.operationId, "create", fingerprint, c);
    if (old) {
      if (!await tx.warehouse.findFirst({ where: { id: old.warehouseId, tenantId: c.tenantId }, select: { id: true } })) throw warehouseAccessError("Owned creation receipt unavailable", 409);
      return { ...old.result, createdAt: new Date(old.result.createdAt) } as Prisma.WarehouseGetPayload<{ select: typeof WAREHOUSE_SELECT }>;
    }
    const { operationId, ...fields } = v; const warehouse = await tx.warehouse.create({ data: { ...fields, tenantId: c.tenantId }, select: WAREHOUSE_SELECT });
    await record(tx, c, operationId, "create", fingerprint, warehouse, "Controlled warehouse creation", warehouse.id); return warehouse;
  }, options);
}

/** Advisory metadata only; creation independently reloads/locks authority. */
export async function readWarehouseProvisioningAuthority(db: PrismaClient, actor: AppUser) {
  const c = context(actor);
  await requireWarehouseAccess(actor, "warehouse.create");
  return db.$transaction(async tx => {
    const m = await member(tx, c.companyMembershipId); agrees(m, c);
    const a = (await tx.$queryRaw<any[]>`SELECT a.*,j.action AS "acceptedAction",j.result AS "acceptedResult" FROM "WarehouseProvisioningAuthority" a
      JOIN "WarehouseProvisioningAction" j ON j."operationId"=a."acceptedOperationId" AND j."membershipId"=a."membershipId" AND j."tenantId"=a."tenantId" AND j."companyId"=a."companyId"
      WHERE a."membershipId"=${m.id}::uuid`)[0];
    if (!a?.enabled || a.profileRevision !== WAREHOUSE_PROVISIONING_REVISION || a.userId !== c.id || a.tenantId !== c.tenantId || a.companyId !== c.companyId || a.tenantMembershipId !== c.tenantMembershipId || a.acceptedAction !== "operator-authorize" || a.acceptedResult?.companyMembershipId !== m.id || a.acceptedResult?.enabled !== true ||
      !keys(m).includes("warehouse.create") || !m.scopes.some(s => s.scopeType === "company" && s.scopeRefId === c.companyId)) throw warehouseAccessError("Accepted warehouse provisioning authority required");
    return { profileRevision: WAREHOUSE_PROVISIONING_REVISION, companyMembershipId: c.companyMembershipId, companyId: c.companyId, tenantId: c.tenantId, accepted: true };
  }, options);
}
