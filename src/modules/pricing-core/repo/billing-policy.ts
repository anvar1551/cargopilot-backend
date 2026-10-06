import { createHash } from "crypto";
import type { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import { stableDraftJson } from "../../finance-core/domain/draft-intent";
import { requireTenantBoundOrderCompanyAuthority, hasCompanyScope } from "../../orders-core/domain/company-authority";
import { parseBillingPolicy } from "../domain/billing-calculation";
import { z } from "zod";
import { requireAcceptedFinancialCapability } from "../../identity-access/application/financial-eligibility";

export const billingHash = (v: unknown) => createHash("sha256").update(stableDraftJson(v)).digest("hex");
export const billingError = (code: string, statusCode = 409) => Object.assign(new Error(code), { code, statusCode });
export const billingActor = (u: AppUser) => ({ actorUserId: u.id, companyMembershipId: u.companyMembershipId!, tenantMembershipId: u.tenantMembershipId! });
export const billingOwner = (u: AppUser) => ({ tenantId: u.tenantId!, companyId: u.companyId! });
export async function billingAuthority(tx: Prisma.TransactionClient, u: AppUser, permission: string) {
  const grant = await requireTenantBoundOrderCompanyAuthority(tx, u, permission);
  if (!hasCompanyScope(grant)) throw billingError("BILLING_COMPANY_SCOPE_REQUIRED", 403);
  await tx.$executeRaw`SET LOCAL lock_timeout='2000ms'`;
  await tx.$executeRaw`SET LOCAL statement_timeout='5000ms'`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${u.tenantId + ":billing:" + u.companyId},0))::text`;
  const fresh = await requireTenantBoundOrderCompanyAuthority(tx, u, permission);
  if (!hasCompanyScope(fresh)) throw billingError("BILLING_COMPANY_SCOPE_REQUIRED", 403);
  await tx.$queryRaw`SELECT id FROM "FinanceLegalEntity" WHERE "tenantId"=${u.tenantId!}::uuid AND "companyId"=${u.companyId!}::uuid FOR SHARE`;
  const entity = await tx.financeLegalEntity.findFirst({ where: { ...billingOwner(u), isActive: true } });
  if (!entity) throw billingError("BILLING_ACTIVE_ENTITY_REQUIRED");
  await requireAcceptedFinancialCapability(tx,u,permission,entity.id);
  return entity;
}
export function assertBillingRetry(row: any, u: AppUser, hash: string) {
  if (row.intentHash !== hash || row.actorUserId !== u.id || row.companyMembershipId !== u.companyMembershipId ||
      row.tenantMembershipId !== u.tenantMembershipId || row.companyId !== u.companyId || row.tenantId !== u.tenantId)
    throw billingError("BILLING_INTENT_CONFLICT");
}
const intentSchema = z.object({ operationId: z.string().uuid().transform(v => v.toLowerCase()), reason: z.string().trim().min(1).max(1000), content: z.unknown() }).strict();
export async function proposeBillingPolicy(u: AppUser, request: unknown) {
  const input = intentSchema.parse(request), content = parseBillingPolicy(input.content), intentHash = billingHash({ reason: input.reason, content });
  return prisma.$transaction(async tx => {
    const entity = await billingAuthority(tx, u, "billing.policies.propose");
    const receipt = await tx.billingPolicyVersion.findUnique({ where: { tenantId_operationId: { tenantId: u.tenantId!, operationId: input.operationId } } });
    if (receipt) { assertBillingRetry(receipt, u, intentHash); return { id: receipt.id, revision: receipt.revision, contentHash: receipt.contentHash }; }
    const previous = await tx.billingPolicyVersion.findFirst({ where: { ...billingOwner(u), legalEntityId: entity.id, currency: content.currency }, orderBy: { revision: "desc" } });
    const row = await tx.billingPolicyVersion.create({ data: { ...billingOwner(u), ...billingActor(u), legalEntityId: entity.id,
      currency: content.currency, revision: (previous?.revision ?? 0) + 1, content: content as Prisma.InputJsonValue, contentHash: billingHash(content),
      operationId: input.operationId, intentHash, reason: input.reason } });
    await tx.financeAuditEvent.create({ data: { legalEntityId: entity.id, actorUserId: u.id, action: "billing.policy.proposed", detailsJson: { versionId: row.id, contentHash: row.contentHash, reason: input.reason } } });
    return { id: row.id, revision: row.revision, contentHash: row.contentHash };
  }, { maxWait: 2000, timeout: 10000 });
}
const decisionSchema = z.object({ versionId: z.string().uuid(), operationId: z.string().uuid(), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(["approved", "rejected"]), reason: z.string().trim().min(1).max(1000) }).strict();
export async function decideBillingPolicy(u: AppUser, request: unknown) {
  const raw = decisionSchema.parse(request), input = { ...raw, versionId: raw.versionId.toLowerCase(), operationId: raw.operationId.toLowerCase() };
  const { operationId, ...normalized } = input, intentHash = billingHash(normalized);
  return prisma.$transaction(async tx => {
    const entity = await billingAuthority(tx, u, "billing.policies.approve");
    const v = await tx.billingPolicyVersion.findFirst({ where: { id: input.versionId, ...billingOwner(u), legalEntityId: entity.id } });
    if (!v) throw billingError("BILLING_POLICY_NOT_FOUND", 404);
    if (v.actorUserId === u.id) throw billingError("BILLING_INDEPENDENT_APPROVER_REQUIRED", 403);
    if (v.contentHash !== input.contentHash || billingHash(parseBillingPolicy(v.content)) !== v.contentHash) throw billingError("BILLING_POLICY_CONTENT_CONFLICT");
    const receipt = await tx.billingPolicyDecision.findUnique({ where: { tenantId_operationId: { tenantId: u.tenantId!, operationId } } });
    if (receipt) { assertBillingRetry(receipt, u, intentHash); return { versionId: receipt.versionId, decision: receipt.decision }; }
    const latest = await tx.billingPolicyVersion.findFirst({ where: { ...billingOwner(u), legalEntityId: entity.id, currency: v.currency }, orderBy: { revision: "desc" } });
    if ((input.decision === "approved" && latest?.id !== v.id) || await tx.billingPolicyDecision.findUnique({ where: { versionId: v.id } }))
      throw billingError("BILLING_POLICY_STALE_OR_DECIDED");
    const previous = await tx.billingPolicyVersion.findFirst({ where: { ...billingOwner(u), legalEntityId: entity.id, currency: v.currency, decisions: { some: { decision: "approved" } } }, orderBy: { revision: "desc" } });
    const row = await tx.billingPolicyDecision.create({ data: { ...billingOwner(u), ...billingActor(u), legalEntityId: entity.id, currency: v.currency,
      versionId: v.id, makerUserId: v.actorUserId, contentHash: v.contentHash, operationId, intentHash, decision: input.decision, reason: input.reason } });
    await tx.financeAuditEvent.create({ data: { legalEntityId: entity.id, actorUserId: u.id, action: "billing.policy." + input.decision,
      detailsJson: { versionId: v.id, contentHash: v.contentHash, supersedesVersionId: input.decision === "approved" ? previous?.id ?? null : null, reason: input.reason } } });
    return { versionId: row.versionId, decision: row.decision };
  }, { maxWait: 2000, timeout: 10000 });
}
export async function loadApprovedBillingPolicy(tx: Prisma.TransactionClient, u: AppUser, entityId: string, currency: string) {
  const v = await tx.billingPolicyVersion.findFirst({ where: { ...billingOwner(u), legalEntityId: entityId, currency, decisions: { some: { decision: "approved" } } }, orderBy: { revision: "desc" } });
  if (!v || billingHash(v.content) !== v.contentHash) throw billingError("BILLING_CURRENCY_POLICY_UNCONFIGURED");
  return { row: v, content: parseBillingPolicy(v.content) };
}
export async function readBillingPolicy(u: AppUser, versionId: string) {
  versionId = z.string().uuid().parse(versionId).toLowerCase();
  return prisma.$transaction(async tx => {
    const entity = await billingAuthority(tx, u, "pricing.read");
    const row = await tx.billingPolicyVersion.findFirst({ where: { id: versionId, ...billingOwner(u), legalEntityId: entity.id },
      select: { id: true, currency: true, revision: true, content: true, contentHash: true, reason: true, createdAt: true, decisions: { take: 1, select: { decision: true, reason: true, createdAt: true } } } });
    if (!row) throw billingError("BILLING_POLICY_NOT_FOUND", 404);
    return row;
  }, { maxWait: 2000, timeout: 10000 });
}
