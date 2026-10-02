import { createHash } from "crypto";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import { requireTenantBoundOrderCompanyAuthority, hasCompanyScope } from "../../orders-core/domain/company-authority";
import { authorityError } from "../../orders-core/domain/creation-authority";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function conflict(): never { throw authorityError("Configuration intent conflicts or revision is stale", 409); }

/** Bounded publication foundation, deliberately not connected to HTTP configuration/rotation routes.
 * Publishes current non-financial scalar configuration, optionally an existing immutable owned secret.
 * No encryption, secret values, network effects, retirement or implicit worker reacceptance.
 */
export async function publishIntegrationProviderConfigurationForActor(args: {
  user: AppUser; providerId: string; operationId: string; expectedRevision: number; secretId?: string;
}) {
  if (Object.keys(args).some(k => !["user", "providerId", "operationId", "expectedRevision", "secretId"].includes(k)) ||
      !uuid.test(args.providerId) || !uuid.test(args.operationId) ||
      (args.secretId !== undefined && !uuid.test(args.secretId)) ||
      !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0 || args.expectedRevision >= 2147483647)
    throw authorityError("Invalid configuration publication intent", 400);
  const providerId = args.providerId.toLowerCase(), operationId = args.operationId.toLowerCase(), requestedSecretId = args.secretId?.toLowerCase();
  const intentSha256 = createHash("sha256").update(JSON.stringify([providerId, args.expectedRevision, requestedSecretId ?? "retain"])).digest("hex");
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL statement_timeout = '3000ms'`;
    await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
    const membership = await requireTenantBoundOrderCompanyAuthority(tx, args.user, "integration.provider.manage");
    if (!hasCompanyScope(membership)) throw authorityError("Explicit company scope required", 403);
    if (requestedSecretId) {
      const rotation = await requireTenantBoundOrderCompanyAuthority(tx, args.user, "integration.provider.rotateSecret");
      if (!hasCompanyScope(rotation)) throw authorityError("Explicit credential company scope required", 403);
    }
    // Serialize operation reuse across providers as well as revisions of one provider.
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${membership.tenantId! + ":" + operationId}, 0))`;
    const context = { companyId: membership.companyId, company: { is: { tenantId: membership.tenantId!, isActive: true, type: "company" as const, tenant: { is: { status: "active" as const } } } } };
    const select = { id: true, companyId: true, domain: true, providerCode: true, environment: true, status: true,
      capabilities: true, retryPolicyId: true, timeoutMs: true, rateLimitRps: true, activeSecretId: true, secretRef: true, configurationRevision: true, currentConfigurationId: true } as const;
    if (!await tx.integrationProvider.findFirst({ where: { ...context, id: providerId }, select: { id: true } })) throw authorityError("Provider not found", 404);
    await tx.$queryRaw`SELECT "id" FROM "IntegrationProvider" WHERE "id"=${providerId}::uuid AND "companyId"=${membership.companyId}::uuid FOR UPDATE`;
    const provider = await tx.integrationProvider.findFirst({ where: { ...context, id: providerId }, select });
    if (!provider) throw authorityError("Provider ownership changed", 403);
    if (provider.domain === "payment") throw authorityError("Financial configuration requires independent approval", 409);
    const receipt = await tx.integrationProviderConfigurationVersion.findUnique({ where: { tenantId_operationId: { tenantId: membership.tenantId!, operationId } } });
    if (receipt) {
      if (receipt.intentSha256 !== intentSha256 || receipt.providerId !== providerId || receipt.companyId !== membership.companyId ||
          receipt.actorUserId !== args.user.id || receipt.companyMembershipId !== args.user.companyMembershipId || receipt.tenantMembershipId !== membership.tenantMembershipId ||
          receipt.revision > provider.configurationRevision ||
          (receipt.revision === provider.configurationRevision && provider.currentConfigurationId !== receipt.id)) conflict();
      return result(receipt);
    }
    if (provider.configurationRevision !== args.expectedRevision) conflict();
    const secretId = requestedSecretId ?? provider.activeSecretId;
    if (!requestedSecretId && ((provider.secretRef === null) !== (provider.activeSecretId === null) ||
        (provider.secretRef && provider.secretRef.toLowerCase() !== provider.activeSecretId))) throw authorityError("Legacy credential requires explicit owned publication", 409);
    if (secretId && !await tx.integrationProviderSecret.findFirst({ where: { id: secretId, providerId }, select: { id: true } })) throw authorityError("Owned credential required", 404);
    const version = await tx.integrationProviderConfigurationVersion.create({ data: {
      tenantId: membership.tenantId!, companyId: membership.companyId, providerId,
      domain: provider.domain, providerCode: provider.providerCode, environment: provider.environment,
      capabilities: provider.capabilities, retryPolicyId: provider.retryPolicyId, status: provider.status, timeoutMs: provider.timeoutMs, rateLimitRps: provider.rateLimitRps,
      actorUserId: args.user.id, companyMembershipId: args.user.companyMembershipId!, tenantMembershipId: membership.tenantMembershipId!,
      operationId, intentSha256, expectedRevision: args.expectedRevision, revision: args.expectedRevision + 1, secretId,
    } });
    const changed = await tx.integrationProvider.updateMany({ where: { ...context, id: providerId, configurationRevision: args.expectedRevision, currentConfigurationId: provider.currentConfigurationId },
      data: { configurationRevision: version.revision, currentConfigurationId: version.id, activeSecretId: secretId, secretRef: secretId, updatedByUserId: args.user.id } });
    if (changed.count !== 1) conflict();
    return result(version);
  }, { maxWait: 2000, timeout: 5000 });
}
function result(row: { id: string; providerId: string; revision: number; operationId: string; acceptedAt: Date }) {
  return { id: row.id, providerId: row.providerId, revision: row.revision, operationId: row.operationId, acceptedAt: row.acceptedAt.toISOString() };
}
