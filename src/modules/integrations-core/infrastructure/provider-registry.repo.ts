import prisma from "../../../config/prismaClient";
import type { IntegrationProviderRef } from "../domain/types";
import type {
  ProviderFilter,
  ProviderRegistryRepository,
  ProviderRegistryService,
} from "../application/provider-registry";

const db = prisma as any;

function toIso(value: Date | string) {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function mapProvider(row: any): IntegrationProviderRef {
  return {
    providerId: row.id,
    companyId: row.companyId,
    domain: row.domain,
    providerCode: row.providerCode,
    status: row.status,
    environment: row.environment,
    capabilities: Array.isArray(row.capabilities)
      ? row.capabilities.map((value: unknown) => String(value))
      : [],
    rateLimitRps: typeof row.rateLimitRps === "number" ? row.rateLimitRps : null,
    timeoutMs: Number(row.timeoutMs ?? 10000),
    retryPolicyId: row.retryPolicyId ?? null,
    secretRef: row.secretRef ?? null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function buildWhere(filter: ProviderFilter) {
  return {
    companyId: filter.companyId,
    ...(filter.domain ? { domain: filter.domain } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.providerCode
      ? { providerCode: String(filter.providerCode).trim() }
      : {}),
  };
}

export const providerRegistryRepository: ProviderRegistryRepository = {
  async findMany(filter) {
    const rows = await db.integrationProvider.findMany({
      where: buildWhere(filter),
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    });
    return rows.map(mapProvider);
  },

  async findById(providerId) {
    const row = await db.integrationProvider.findUnique({
      where: { id: providerId },
    });
    return row ? mapProvider(row) : null;
  },

  async findOne(args) {
    const row = await db.integrationProvider.findFirst({
      where: {
        companyId: args.companyId,
        domain: args.domain,
        providerCode: String(args.providerCode || "").trim(),
      },
      orderBy: [{ updatedAt: "desc" }],
    });
    return row ? mapProvider(row) : null;
  },

  async updateStatus(args) {
    await db.integrationProvider.update({
      where: { id: args.providerId },
      data: { status: args.status },
    });
  },

  async rotateSecret(args) {
    await db.$transaction(async (tx: any) => {
      const created = await tx.integrationProviderSecret.create({
        data: {
          providerId: args.providerId,
          keyVersion: args.keyVersion,
          encryptedSecretJson: args.encryptedSecretJson,
          rotatedAt: new Date(),
        },
      });

      await tx.integrationProvider.update({
        where: { id: args.providerId },
        data: { secretRef: created.id },
      });
    });
  },
};

export const providerRegistryService: ProviderRegistryService = {
  async listActiveProviders(args) {
    return providerRegistryRepository.findMany({
      companyId: args.companyId,
      domain: args.domain,
      status: "active",
    });
  },

  async resolveProvider(args) {
    if (args.providerId) {
      const provider = await providerRegistryRepository.findById(args.providerId);
      if (
        provider &&
        provider.companyId === args.companyId &&
        provider.domain === args.domain &&
        provider.status === "active" &&
        (!args.environment || provider.environment === args.environment)
      ) {
        return provider;
      }
      return null;
    }

    const list = await providerRegistryRepository.findMany({
      companyId: args.companyId,
      domain: args.domain,
      status: "active",
      ...(args.providerCode ? { providerCode: args.providerCode } : {}),
    });

    return list.find((provider) => !args.environment || provider.environment === args.environment) ?? null;
  },
};
