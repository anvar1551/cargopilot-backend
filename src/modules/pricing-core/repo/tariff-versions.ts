import { createHash } from "crypto";
import type { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import { requireTenantBoundOrderCompanyAuthority, hasCompanyScope } from "../../orders-core/domain/company-authority";
import { authorityError } from "../../orders-core/domain/creation-authority";
import { stableDraftJson } from "../../finance-core/domain/draft-intent";
import { requireCustomerEntityReference } from "../../customers-core/application/customerEntityRepo";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const conflict = () => { throw Object.assign(authorityError("Tariff intent conflicts or source changed", 409), { code: "TARIFF_PUBLICATION_CONFLICT" }); };
const digest = (value: unknown) => createHash("sha256").update(stableDraftJson(value)).digest("hex");
const owner = (user: AppUser) => ({ tenantId: user.tenantId!, companyId: user.companyId! });
const actor = (user: AppUser) => ({ actorUserId: user.id, companyMembershipId: user.companyMembershipId!, tenantMembershipId: user.tenantMembershipId! });
function input(args: Record<string, any>, fields: string[]) {
  if (Object.keys(args).some(key => !["user", "planId", "operationId", "reason", ...fields].includes(key)) ||
      !uuid.test(args.planId) || !uuid.test(args.operationId) || typeof args.reason !== "string" || !args.reason.trim() || args.reason.trim().length > 1000)
    throw authorityError("Invalid tariff publication request", 400);
}
export async function lockTariffAuthoring(tx: Prisma.TransactionClient, tenantId: string, companyId: string) {
  await tx.$executeRaw`SET LOCAL lock_timeout='2000ms'`;
  await tx.$executeRaw`SET LOCAL statement_timeout='5000ms'`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ":tariff-authoring:" + companyId},0))::text`;
}
async function authority(tx: Prisma.TransactionClient, user: AppUser, permission: string) {
  const membership = await requireTenantBoundOrderCompanyAuthority(tx, user, permission);
  if (!hasCompanyScope(membership)) throw authorityError("Explicit selected-company tariff scope required", 403);
  await lockTariffAuthoring(tx, membership.tenantId!, membership.companyId);
  // A queued authoring lock must not preserve permissions revoked while waiting.
  const current = await requireTenantBoundOrderCompanyAuthority(tx, user, permission);
  if (!hasCompanyScope(current)) throw authorityError("Explicit selected-company tariff scope required", 403);
}
async function loadPlan(tx: Prisma.TransactionClient, user: AppUser, planId: string) {
  await tx.$queryRaw`SELECT id FROM "TariffPlan" WHERE id=${planId}::uuid AND "tenantId"=${user.tenantId!}::uuid AND "companyId"=${user.companyId!}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT t.id FROM "RouteTemplate" t JOIN "TariffPlan" p ON p."routeTemplateId"=t.id WHERE p.id=${planId}::uuid AND p."tenantId"=${user.tenantId!}::uuid AND p."companyId"=${user.companyId!}::uuid FOR UPDATE OF t`;
  await tx.$queryRaw`SELECT l.id FROM "RouteTemplateLeg" l JOIN "TariffPlan" p ON p."routeTemplateId"=l."routeTemplateId" WHERE p.id=${planId}::uuid AND p."tenantId"=${user.tenantId!}::uuid AND p."companyId"=${user.companyId!}::uuid ORDER BY l.sequence,l.id LIMIT 101 FOR SHARE OF l`;
  const plan = await tx.tariffPlan.findFirst({ where: { id: planId, ...owner(user) }, include: {
    rates: { take: 501, orderBy: [{ zone: "asc" }, { weightFromKg: "asc" }, { weightToKg: "asc" }, { id: "asc" }] },
    routeTemplate: { select: { id: true, companyId: true, configurationRevision: true, currentConfigurationId: true, name: true, code: true, isActive: true, priority: true, serviceType: true, transportMode: true,
      originCountryCode: true, destinationCountryCode: true, legs: { take: 101, orderBy: [{ sequence: "asc" }, { id: "asc" }], select: { id: true, sequence: true, legCode: true, label: true, mode: true, originCountryCode: true, destinationCountryCode: true } } } },
  } });
  if (!plan) throw authorityError("Tariff not found", 404);
  if (plan.rates.length > 500 || (plan.routeTemplate && (plan.routeTemplate.companyId !== user.companyId || plan.routeTemplate.legs.length > 100))) conflict();
  if (plan.customerEntityId) await requireCustomerEntityReference(user, plan.customerEntityId);
  return plan;
}
function content(plan: Awaited<ReturnType<typeof loadPlan>>) {
  if (plan.pricingStrategy !== "FIXED_LANE" || plan.priceType !== "bucket" || plan.transitPricingConfig != null)
    throw Object.assign(authorityError("Supported exact tariff calculation policy required", 409), { code: "TARIFF_CALCULATION_POLICY_REQUIRED" });
  if (plan.routeTemplate && !plan.routeTemplate.isActive) conflict();
  // Freeze exact stored decimal values; this does not approve a financial calculation recipe.
  const value = { planId: plan.id, tenantId: plan.tenantId, companyId: plan.companyId, name: plan.name, code: plan.code, description: plan.description,
    status: plan.status, serviceType: plan.serviceType, priceType: plan.priceType, pricingStrategy: plan.pricingStrategy, coverageType: plan.coverageType,
    transportMode: plan.transportMode, originCountryCode: plan.originCountryCode, destinationCountryCode: plan.destinationCountryCode,
    currency: plan.currency, priority: plan.priority, isDefault: plan.isDefault, customerEntityId: plan.customerEntityId,
    routeTemplateId: plan.routeTemplateId, routeTemplate: plan.routeTemplate, transitPricingConfig: plan.transitPricingConfig,
    rates: plan.rates.map(rate => ({ id: rate.id, zone: rate.zone, weightFromKg: rate.weightFromKg.toString(), weightToKg: rate.weightToKg.toString(), price: rate.price.toString() })) };
  const encoded = stableDraftJson(value);
  if (Buffer.byteLength(encoded) > 192 * 1024) throw authorityError("Tariff snapshot exceeds supported limits", 409);
  return { value, sha256: createHash("sha256").update(encoded).digest("hex") };
}
function matches(row: any, user: AppUser, sha256: string) {
  if (row.intentSha256 !== sha256 || row.actorUserId !== user.id || row.companyMembershipId !== user.companyMembershipId || row.tenantMembershipId !== user.tenantMembershipId || row.companyId !== user.companyId) conflict();
}
async function historicalScope(tx: Prisma.TransactionClient, user: AppUser, snapshot: any) {
  if (snapshot.tenantId !== user.tenantId || snapshot.companyId !== user.companyId) conflict();
  if (snapshot.customerEntityId) await requireCustomerEntityReference(user, snapshot.customerEntityId);
  if (snapshot.routeTemplateId && !await tx.routeTemplate.findFirst({ where: { id: snapshot.routeTemplateId, companyId: user.companyId, company: { tenantId: user.tenantId } }, select: { id: true } })) conflict();
}
function versionResult(row: any) { return { id: row.id, planId: row.planId, sourceGeneration: row.sourceGeneration, contentSha256: row.contentSha256, proposedAt: row.proposedAt.toISOString() }; }
function decisionResult(row: any) { return { versionId: row.versionId, planId: row.planId, decision: row.decision, contentSha256: row.contentSha256, previousVersionId: row.previousVersionId, decidedAt: row.decidedAt.toISOString() }; }

export async function proposeTariffVersion(args: { user: AppUser; planId: string; operationId: string; expectedGeneration: number; reason: string }) {
  input(args, ["expectedGeneration"]);
  if (!Number.isSafeInteger(args.expectedGeneration) || args.expectedGeneration < 0 || args.expectedGeneration >= 2147483647) throw authorityError("Invalid tariff generation", 400);
  const planId = args.planId.toLowerCase(), operationId = args.operationId.toLowerCase(), reason = args.reason.trim();
  const intentSha256 = digest({ planId, expectedGeneration: args.expectedGeneration, reason });
  return prisma.$transaction(async tx => {
    await authority(tx, args.user, "pricing.tariffs.propose");
    const plan = await loadPlan(tx, args.user, planId);
    const receipt = await tx.tariffConfigurationVersion.findUnique({ where: { tenantId_operationId: { tenantId: args.user.tenantId!, operationId } } });
    if (receipt) { matches(receipt, args.user, intentSha256); if (receipt.planId !== planId) conflict(); await historicalScope(tx, args.user, receipt.content); return versionResult(receipt); }
    if (plan.status === "archived" || plan.contentGeneration !== args.expectedGeneration || await tx.tariffConfigurationVersion.findUnique({ where: { planId_sourceGeneration: { planId, sourceGeneration: plan.contentGeneration } } })) conflict();
    const snapshot = content(plan);
    const version = await tx.tariffConfigurationVersion.create({ data: { ...owner(args.user), ...actor(args.user), planId, sourceGeneration: plan.contentGeneration,
      contentSha256: snapshot.sha256, content: snapshot.value as Prisma.InputJsonValue, operationId, intentSha256, reason } });
    return versionResult(version);
  }, { maxWait: 2000, timeout: 10000 });
}
export async function decideTariffVersion(args: { user: AppUser; planId: string; versionId: string; operationId: string; contentSha256: string; decision: "approved" | "rejected"; reason: string }) {
  input(args, ["versionId", "contentSha256", "decision"]);
  if (!uuid.test(args.versionId) || !/^[a-f0-9]{64}$/.test(args.contentSha256) || !["approved", "rejected"].includes(args.decision)) throw authorityError("Invalid tariff decision", 400);
  const planId = args.planId.toLowerCase(), versionId = args.versionId.toLowerCase(), operationId = args.operationId.toLowerCase(), reason = args.reason.trim();
  const intentSha256 = digest({ planId, versionId, contentSha256: args.contentSha256, decision: args.decision, reason });
  return prisma.$transaction(async tx => {
    await authority(tx, args.user, "pricing.tariffs.approve");
    const plan = await loadPlan(tx, args.user, planId);
    const version = await tx.tariffConfigurationVersion.findFirst({ where: { id: versionId, planId, ...owner(args.user) } });
    if (!version) throw authorityError("Tariff version not found", 404);
    await historicalScope(tx, args.user, version.content);
    if (version.actorUserId === args.user.id) throw authorityError("Independent tariff approver required", 403);
    if (version.contentSha256 !== args.contentSha256 || digest(version.content) !== version.contentSha256) conflict();
    const receipt = await tx.tariffPublicationDecision.findUnique({ where: { tenantId_operationId: { tenantId: args.user.tenantId!, operationId } } });
    if (receipt) { matches(receipt, args.user, intentSha256); if (receipt.versionId !== versionId) conflict(); return decisionResult(receipt); }
    if (await tx.tariffPublicationDecision.findUnique({ where: { versionId } })) conflict();
    if (args.decision === "approved" && (plan.status === "archived" || version.sourceGeneration !== plan.contentGeneration || content(plan).sha256 !== version.contentSha256)) conflict();
    const decision = await tx.tariffPublicationDecision.create({ data: { ...owner(args.user), ...actor(args.user), planId, versionId, sourceGeneration: version.sourceGeneration,
      contentSha256: version.contentSha256, makerUserId: version.actorUserId, decision: args.decision, operationId, intentSha256, reason,
      previousVersionId: args.decision === "approved" ? plan.approvedVersionId : null } });
    if (args.decision === "approved") {
      const changed = await tx.tariffPlan.updateMany({ where: { id: planId, ...owner(args.user), contentGeneration: version.sourceGeneration, approvedVersionId: plan.approvedVersionId }, data: { approvedVersionId: versionId, approvedDecision: "approved", status: "active" } });
      if (changed.count !== 1) conflict();
    }
    return decisionResult(decision);
  }, { maxWait: 2000, timeout: 10000 });
}
export async function readTariffVersion(user: AppUser, planId: string, versionId: string) {
  if (!uuid.test(planId) || !uuid.test(versionId)) throw authorityError("Invalid tariff reference", 400);
  return prisma.$transaction(async tx => {
    await authority(tx, user, "pricing.read");
    await loadPlan(tx, user, planId.toLowerCase());
    const row = await tx.tariffConfigurationVersion.findFirst({ where: { id: versionId.toLowerCase(), planId: planId.toLowerCase(), ...owner(user) }, select: { id: true, planId: true, sourceGeneration: true, contentSha256: true, content: true, reason: true, proposedAt: true, decisions: { take: 1, select: { decision: true, reason: true, previousVersionId: true, decidedAt: true } } } });
    if (!row) throw authorityError("Tariff version not found", 404);
    await historicalScope(tx, user, row.content);
    const { decisions, ...projected } = row;
    return { ...projected, decision: decisions[0] ?? null };
  }, { maxWait: 2000, timeout: 10000 });
}
