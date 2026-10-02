import { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import { authorityError } from "../../orders-core/domain/creation-authority";
import { integrationProviderContext } from "./provider-access";

type Domain = "carrier" | "sms" | "payment" | "webhook_sink";
type Status = "pending" | "processing" | "sent" | "failed" | "dead_letter";
const domains: Domain[] = ["carrier", "sms", "payment", "webhook_sink"];
const statuses: Status[] = ["pending", "processing", "sent", "failed", "dead_letter"];
function bounded(value: number | undefined, fallback: number, max: number) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > max))
    throw authorityError("Invalid integration pagination", 400);
  return value ?? fallback;
}
const iso = (value: Date | null) => value?.toISOString() ?? null;
const attemptSelect = {
  id: true, outboxId: true, attemptNo: true, outcome: true, statusCode: true,
  retryable: true, startedAt: true, finishedAt: true, createdAt: true,
} satisfies Prisma.IntegrationDeliveryAttemptSelect;
function attempt(row: Prisma.IntegrationDeliveryAttemptGetPayload<{ select: typeof attemptSelect }>) {
  return { id: row.id, outboxId: row.outboxId, attemptNo: row.attemptNo, outcome: row.outcome,
    statusCode: row.statusCode, retryable: row.retryable, errorMessage: null, providerRequestId: null,
    requestJson: null, responseJson: null, startedAt: iso(row.startedAt), finishedAt: iso(row.finishedAt), createdAt: iso(row.createdAt) };
}

/** Bound the tuple expansion; repeat each tuple at the actual read to close configuration-change races. */
async function ownership(user: AppUser, companyId?: string, domain?: Domain, providerCode?: string) {
  const context = await integrationProviderContext(user, "integration.outbox.read", companyId);
  if (domain !== undefined && !domains.includes(domain)) throw authorityError("Invalid integration domain", 400);
  if (providerCode !== undefined && (typeof providerCode !== "string" || !/^[a-z0-9_-]{1,64}$/i.test(providerCode.trim())))
    throw authorityError("Invalid integration provider code", 400);
  const providers = await prisma.integrationProvider.findMany({
    where: { ...context, ...(domain ? { domain } : {}), ...(providerCode ? { providerCode: providerCode.trim().toLowerCase() } : {}) },
    select: { id: true, domain: true, providerCode: true, environment: true }, orderBy: { id: "asc" }, take: 101,
  });
  if (providers.length > 100) throw Object.assign(authorityError("Integration read capacity exceeded", 409), { code: "INTEGRATION_READ_CAPACITY" });
  // An empty tuple set is explicitly false; it never becomes an unfiltered query.
  const where: Prisma.IntegrationOutboxWhereInput = { ...context, AND: [
    { OR: providers.map(provider => ({ providerId: provider.id, domain: provider.domain,
      providerCode: provider.providerCode, environment: provider.environment,
      provider: { is: { ...context, id: provider.id, domain: provider.domain,
        providerCode: provider.providerCode, environment: provider.environment } } })) },
    { OR: [{ ownershipTenantId: null, ownershipOrderId: null }, {
      ownershipTenantId: context.company.is.tenantId, ownershipOrderId: { not: null },
      ownedOrder: { is: { tenantId: context.company.is.tenantId, ownerOrgId: context.companyId } },
    }] },
  ] };
  return where;
}

export async function listIntegrationOutboxForActor(args: { user: AppUser; companyId?: string;
  status?: Status; domain?: Domain; providerCode?: string; page?: number; limit?: number }) {
  const page = bounded(args.page, 1, 10000), limit = bounded(args.limit, 20, 100);
  if (args.status !== undefined && !statuses.includes(args.status)) throw authorityError("Invalid integration status", 400);
  const where: Prisma.IntegrationOutboxWhereInput = { ...await ownership(args.user, args.companyId, args.domain, args.providerCode),
    ...(args.status ? { status: args.status } : {}) };
  const select = { id: true, companyId: true, providerId: true, providerCode: true, domain: true, environment: true,
    status: true, maxAttempts: true, attemptCount: true, nextAttemptAt: true, lastAttemptAt: true, createdAt: true, updatedAt: true,
    provider: { select: { id: true, providerCode: true, status: true, environment: true } },
    attempts: { orderBy: { attemptNo: "desc" as const }, take: 1, select: attemptSelect },
  } satisfies Prisma.IntegrationOutboxSelect;
  const [rows, total] = await prisma.$transaction([
    prisma.integrationOutbox.findMany({ where, select, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], skip: (page - 1) * limit, take: limit }),
    prisma.integrationOutbox.count({ where }),
  ]);
  return { items: rows.map(row => ({ id: row.id, companyId: row.companyId, providerId: row.providerId,
    providerCode: row.providerCode, domain: row.domain, environment: row.environment,
    // Business payload identifiers and free-text diagnostics are not authorized by integration metadata permission.
    eventType: null, aggregateType: null, aggregateId: null, operation: null, idempotencyKey: null, lastError: null,
    status: row.status, maxAttempts: row.maxAttempts, attemptCount: row.attemptCount,
    nextAttemptAt: iso(row.nextAttemptAt), lastAttemptAt: iso(row.lastAttemptAt), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
    provider: row.provider ? { id: row.provider.id, providerCode: row.provider.providerCode,
      status: row.provider.status, environment: row.provider.environment } : null,
    latestAttempt: row.attempts[0] ? attempt(row.attempts[0]) : null,
  })), total, page, limit };
}

export async function listIntegrationOutboxAttemptsForActor(args: { user: AppUser; outboxId: string; limit?: number }) {
  const limit = bounded(args.limit, 50, 200);
  if (typeof args.outboxId !== "string" || !args.outboxId.trim()) throw authorityError("Outbox id required", 400);
  const where: Prisma.IntegrationOutboxWhereInput = { ...await ownership(args.user), id: args.outboxId };
  const parent = await prisma.integrationOutbox.findFirst({ where, select: { id: true } });
  if (!parent) throw authorityError("Outbox record not found", 404);
  const rows = await prisma.integrationDeliveryAttempt.findMany({
    where: { outboxId: parent.id, outbox: { is: where } }, select: attemptSelect,
    orderBy: [{ attemptNo: "desc" }, { id: "desc" }], take: limit,
  });
  return rows.map(attempt);
}
