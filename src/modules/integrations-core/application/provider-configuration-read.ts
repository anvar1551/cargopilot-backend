import { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import { authorityError } from "../../orders-core/domain/creation-authority";
import { integrationProviderContext } from "./provider-access";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const projection = { id: true, revision: true, acceptedAt: true, domain: true, environment: true,
  status: true, timeoutMs: true, rateLimitRps: true } satisfies Prisma.IntegrationProviderConfigurationVersionSelect;

/** Safe action/version metadata only, not an audit actor or credential export. */
export async function listIntegrationProviderConfigurationsForActor(args: {
  user: AppUser; providerId: string; cursor?: string; limit?: number;
}) {
  const context = await integrationProviderContext(args.user, "integration.provider.read");
  if (!uuid.test(args.providerId) || (args.cursor !== undefined && !uuid.test(args.cursor)) ||
      (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 100)))
    throw authorityError("Invalid configuration read request", 400);
  const providerId = args.providerId.toLowerCase(), limit = args.limit ?? 25;
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '3000ms'`;
    await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
    const provider = await tx.integrationProvider.findFirst({ where: { ...context, id: providerId },
      select: { id: true, configurationRevision: true, currentConfigurationId: true } });
    if (!provider) throw authorityError("Provider not found", 404);
    const where: Prisma.IntegrationProviderConfigurationVersionWhereInput = {
      tenantId: context.company.is.tenantId, companyId: context.companyId, providerId,
      provider: { is: { ...context, id: providerId } },
    };
    const cursor = args.cursor ? await tx.integrationProviderConfigurationVersion.findFirst({
      where: { ...where, id: args.cursor.toLowerCase() }, select: { revision: true },
    }) : null;
    if (args.cursor && !cursor) throw authorityError("Configuration cursor not found", 404);
    const rows = await tx.integrationProviderConfigurationVersion.findMany({
      where: { ...where, ...(cursor ? { revision: { lt: cursor.revision } } : {}) },
      take: limit + 1, orderBy: { revision: "desc" }, select: projection,
    });
    const data = rows.slice(0, limit).map(row => ({ id: row.id, revision: row.revision,
      acceptedAt: row.acceptedAt.toISOString(), domain: row.domain, environment: row.environment,
      status: row.status, timeoutMs: row.timeoutMs, rateLimitRps: row.rateLimitRps }));
    return { providerId, currentRevision: provider.configurationRevision, currentConfigurationId: provider.currentConfigurationId,
      data, total: await tx.integrationProviderConfigurationVersion.count({ where }),
      pageInfo: { limit, hasNextPage: rows.length > limit, nextCursor: rows.length > limit ? data[data.length - 1]?.id ?? null : null } };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 2000, timeout: 5000 });
}
