"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.providerRegistryService = exports.providerRegistryRepository = void 0;
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const db = prismaClient_1.default;
function toIso(value) {
    if (value instanceof Date)
        return value.toISOString();
    return new Date(value).toISOString();
}
function mapProvider(row) {
    return {
        providerId: row.id,
        companyId: row.companyId,
        domain: row.domain,
        providerCode: row.providerCode,
        status: row.status,
        environment: row.environment,
        capabilities: Array.isArray(row.capabilities)
            ? row.capabilities.map((value) => String(value))
            : [],
        rateLimitRps: typeof row.rateLimitRps === "number" ? row.rateLimitRps : null,
        timeoutMs: Number(row.timeoutMs ?? 10000),
        retryPolicyId: row.retryPolicyId ?? null,
        secretRef: row.secretRef ?? null,
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
    };
}
function buildWhere(filter) {
    return {
        companyId: filter.companyId,
        ...(filter.domain ? { domain: filter.domain } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.providerCode
            ? { providerCode: String(filter.providerCode).trim() }
            : {}),
    };
}
exports.providerRegistryRepository = {
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
        await db.$transaction(async (tx) => {
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
exports.providerRegistryService = {
    async listActiveProviders(args) {
        return exports.providerRegistryRepository.findMany({
            companyId: args.companyId,
            domain: args.domain,
            status: "active",
        });
    },
    async resolveProvider(args) {
        if (args.providerId) {
            const provider = await exports.providerRegistryRepository.findById(args.providerId);
            if (provider &&
                provider.companyId === args.companyId &&
                provider.domain === args.domain &&
                provider.status === "active" &&
                (!args.environment || provider.environment === args.environment)) {
                return provider;
            }
            return null;
        }
        const list = await exports.providerRegistryRepository.findMany({
            companyId: args.companyId,
            domain: args.domain,
            status: "active",
            ...(args.providerCode ? { providerCode: args.providerCode } : {}),
        });
        return list.find((provider) => !args.environment || provider.environment === args.environment) ?? null;
    },
};
