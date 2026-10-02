import { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import { hasCompanyScope, requireTenantBoundOrderCompanyAuthority } from "../../orders-core/domain/company-authority";
import { authorityError } from "../../orders-core/domain/creation-authority";

/** Company-wide integration configuration requires an explicit selected company grant. */
export async function integrationProviderContext(user: AppUser, permission: string, requestedCompany?: string) {
  const membership = await requireTenantBoundOrderCompanyAuthority(prisma, user, permission);
  if (!hasCompanyScope(membership)) throw authorityError("Explicit integration company scope required", 403);
  if (requestedCompany !== undefined && requestedCompany !== membership.companyId)
    throw authorityError("Selected integration company mismatch", 403);
  return { companyId: membership.companyId, company: { is: {
    id: membership.companyId, tenantId: membership.tenantId!, type: "company" as const,
    isActive: true, tenant: { is: { status: "active" as const } },
  } } };
}

const providerReadSelect = {
  id: true, companyId: true, domain: true, providerCode: true, status: true, environment: true,
  capabilities: true, rateLimitRps: true, timeoutMs: true, retryPolicyId: true, createdAt: true, updatedAt: true,
} satisfies Prisma.IntegrationProviderSelect;

export async function listIntegrationProvidersForActor(args: { user: AppUser; companyId?: string;
  domain?: "carrier" | "sms" | "payment" | "webhook_sink"; status?: "active" | "paused" | "disabled";
  environment?: "sandbox" | "production"; providerCode?: string; q?: string; cursor?: string; limit?: number }) {
  const context = await integrationProviderContext(args.user, "integration.provider.read", args.companyId);
  if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 100))
    throw authorityError("Integration provider limit must be from 1 to 100", 400);
  if (args.cursor !== undefined && (typeof args.cursor !== "string" || !args.cursor.trim() || args.limit === undefined))
    throw authorityError("Integration provider cursor requires a paginated request", 400);
  if (args.q !== undefined && (typeof args.q !== "string" || args.q.length > 180))
    throw authorityError("Integration provider search is too long", 400);
  if (args.providerCode !== undefined && (typeof args.providerCode !== "string" || !/^[a-z0-9_-]{1,64}$/i.test(args.providerCode.trim())))
    throw authorityError("Invalid integration provider code", 400);
  const where: Prisma.IntegrationProviderWhereInput = { ...context,
    ...(args.domain ? { domain: args.domain } : {}), ...(args.status ? { status: args.status } : {}),
    ...(args.environment ? { environment: args.environment } : {}),
    ...(args.providerCode ? { providerCode: args.providerCode.trim().toLowerCase() } : {}),
    ...(args.q?.trim() ? { OR: [{ providerCode: { contains: args.q.trim(), mode: "insensitive" } },
      { retryPolicyId: { contains: args.q.trim(), mode: "insensitive" } }] } : {}),
  };
  if (args.cursor) {
    const cursor = await prisma.integrationProvider.findFirst({ where: { AND: [where, { id: args.cursor }] }, select: { id: true } });
    if (!cursor) throw authorityError("Integration provider cursor not found", 404);
  }
  const paginated = args.limit !== undefined, limit = args.limit ?? 100;
  const rows = await prisma.integrationProvider.findMany({ where,
    orderBy: [{ domain: "asc" }, { providerCode: "asc" }, { environment: "asc" }, { id: "asc" }],
    take: paginated ? limit + 1 : limit,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}), select: providerReadSelect,
  });
  const mapped = rows.slice(0, limit).map(row => ({ id: row.id, companyId: row.companyId,
    domain: row.domain, providerCode: row.providerCode, status: row.status, environment: row.environment,
    capabilities: row.capabilities, rateLimitRps: row.rateLimitRps, timeoutMs: row.timeoutMs,
    retryPolicyId: row.retryPolicyId, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }));
  if (!paginated) return mapped;
  const total = await prisma.integrationProvider.count({ where });
  return { data: mapped, total, pageInfo: { limit, hasNextPage: rows.length > limit,
    nextCursor: rows.length > limit ? mapped[mapped.length - 1]?.id ?? null : null } };
}
