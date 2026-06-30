import { MembershipStatus, Prisma, ServiceType, TransportMode } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import { authorize, hasAnyPermissionSync } from "../../identity-access";
import type { AppUser } from "../../../types/app-user";

type AuthUser = AppUser;

const db = prisma as any;

type CarrierRoutingRuleInput = {
  companyId: string;
  name: string;
  code?: string | null;
  providerId: string;
  fallbackProviderId?: string | null;
  routeTemplateId?: string | null;
  routeTemplateLegId?: string | null;
  isActive?: boolean;
  priority?: number;
  autoBook?: boolean;
  serviceType?: ServiceType | null;
  transportMode?: TransportMode | null;
  originCountryCode?: string | null;
  destinationCountryCode?: string | null;
  minWeightKg?: number | null;
  maxWeightKg?: number | null;
  legSequence?: number | null;
  conditionsJson?: unknown;
};

type CarrierRoutingRuleFilters = {
  companyId?: string;
  providerId?: string;
  routeTemplateId?: string;
  isActive?: boolean;
  q?: string;
  cursor?: string;
  limit?: number;
};

export type ResolvedCarrierRoutingRule = {
  id: string;
  companyId: string;
  providerId: string;
  providerCode: string;
  providerEnvironment: string;
  fallbackProviderId: string | null;
  name: string;
  code: string | null;
  priority: number;
  autoBook: boolean;
};

function toIso(value: Date | string | null | undefined) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function normalizeOptionalCode(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .replace(/[-\s]+/g, "_")
    .replace(/[^A-Za-z0-9_]/g, "")
    .toUpperCase();
  return normalized || null;
}

function normalizeCountryCode(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

function numberOrNull(value: unknown) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function intOrNull(value: unknown) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : NaN;
}

function boolOrDefault(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function canOverrideScope(user: AuthUser) {
  return hasAnyPermissionSync(user, ["policy.override"]);
}

async function listAccessibleCompanyIds(user: AuthUser): Promise<string[] | null> {
  if (canOverrideScope(user)) return null;
  const memberships = await db.companyMembership.findMany({
    where: {
      userId: user.id,
      status: MembershipStatus.active,
    },
    select: { companyId: true },
  });
  return Array.from(
    new Set(memberships.map((item: { companyId: string }) => item.companyId).filter(Boolean)),
  );
}

async function assertCompanyAccess(user: AuthUser, companyId: string, permission: string) {
  await authorize(user, permission);
  const scopedIds = await listAccessibleCompanyIds(user);
  if (scopedIds === null || scopedIds.includes(companyId)) return;
  const err = new Error("Forbidden for this company") as Error & { statusCode: number };
  err.statusCode = 403;
  throw err;
}

async function getRuleAccessibleOrThrow(user: AuthUser, ruleId: string, permission: string) {
  await authorize(user, permission);
  const scopedIds = await listAccessibleCompanyIds(user);
  const rule = await db.carrierRoutingRule.findUnique({
    where: { id: ruleId },
    include: {
      provider: {
        select: { id: true, providerCode: true, environment: true, status: true, domain: true },
      },
      fallbackProvider: {
        select: { id: true, providerCode: true, environment: true, status: true, domain: true },
      },
    },
  });
  if (!rule) {
    const err = new Error("Carrier routing rule not found") as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }
  if (scopedIds !== null && !scopedIds.includes(rule.companyId)) {
    const err = new Error("Forbidden for this routing rule") as Error & { statusCode: number };
    err.statusCode = 403;
    throw err;
  }
  return rule;
}

function mapRuleRow(row: any) {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    code: row.code ?? null,
    providerId: row.providerId,
    providerCode: row.provider?.providerCode ?? null,
    providerEnvironment: row.provider?.environment ?? null,
    fallbackProviderId: row.fallbackProviderId ?? null,
    fallbackProviderCode: row.fallbackProvider?.providerCode ?? null,
    routeTemplateId: row.routeTemplateId ?? null,
    routeTemplateName: row.routeTemplate?.name ?? null,
    routeTemplateCode: row.routeTemplate?.code ?? null,
    routeTemplateLegId: row.routeTemplateLegId ?? null,
    routeTemplateLegCode: row.routeTemplateLeg?.legCode ?? null,
    routeTemplateLegSequence: row.routeTemplateLeg?.sequence ?? null,
    isActive: Boolean(row.isActive),
    priority: Number(row.priority ?? 0),
    autoBook: Boolean(row.autoBook),
    serviceType: row.serviceType ?? null,
    transportMode: row.transportMode ?? null,
    originCountryCode: row.originCountryCode ?? null,
    destinationCountryCode: row.destinationCountryCode ?? null,
    minWeightKg: row.minWeightKg == null ? null : Number(row.minWeightKg),
    maxWeightKg: row.maxWeightKg == null ? null : Number(row.maxWeightKg),
    legSequence: row.legSequence ?? null,
    conditionsJson: row.conditionsJson ?? null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

async function assertRouteTemplateForCompany(args: {
  companyId: string;
  routeTemplateId?: string | null;
  routeTemplateLegId?: string | null;
}) {
  const routeTemplateId = String(args.routeTemplateId || "").trim() || null;
  const routeTemplateLegId = String(args.routeTemplateLegId || "").trim() || null;
  if (!routeTemplateId && !routeTemplateLegId) return;

  let routeTemplate = null;
  if (routeTemplateId) {
    routeTemplate = await db.routeTemplate.findFirst({
      where: { id: routeTemplateId, companyId: args.companyId },
      select: { id: true },
    });
    if (!routeTemplate) {
      const err = new Error("routeTemplateId must belong to the same company") as Error & {
        statusCode: number;
      };
      err.statusCode = 400;
      throw err;
    }
  }

  if (routeTemplateLegId) {
    const leg = await db.routeTemplateLeg.findFirst({
      where: {
        id: routeTemplateLegId,
        routeTemplate: {
          companyId: args.companyId,
          ...(routeTemplateId ? { id: routeTemplateId } : {}),
        },
      },
      select: { id: true, routeTemplateId: true },
    });
    if (!leg) {
      const err = new Error(
        "routeTemplateLegId must belong to the same company and route template",
      ) as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    }
  }
}

async function assertCarrierProviderForCompany(args: {
  providerId: string | null | undefined;
  companyId: string;
  fieldName: string;
}) {
  if (!args.providerId) return null;
  const provider = await db.integrationProvider.findFirst({
    where: {
      id: args.providerId,
      companyId: args.companyId,
      domain: "carrier",
    },
    select: {
      id: true,
      status: true,
      providerCode: true,
      environment: true,
    },
  });
  if (!provider) {
    const err = new Error(`${args.fieldName} must be a carrier provider in the same company`) as Error & {
      statusCode: number;
    };
    err.statusCode = 400;
    throw err;
  }
  return provider;
}

function normalizeRuleInput(input: CarrierRoutingRuleInput) {
  const name = String(input.name || "").trim();
  if (!name) {
    const err = new Error("name is required") as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }

  const priority = Number(input.priority ?? 0);
  if (!Number.isFinite(priority)) {
    const err = new Error("priority must be a number") as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }

  const minWeightKg = numberOrNull(input.minWeightKg);
  const maxWeightKg = numberOrNull(input.maxWeightKg);
  if (Number.isNaN(minWeightKg) || Number.isNaN(maxWeightKg)) {
    const err = new Error("weight bounds must be numeric") as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  if (minWeightKg != null && minWeightKg < 0) {
    const err = new Error("minWeightKg must be >= 0") as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  if (maxWeightKg != null && maxWeightKg <= 0) {
    const err = new Error("maxWeightKg must be > 0") as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  if (minWeightKg != null && maxWeightKg != null && maxWeightKg < minWeightKg) {
    const err = new Error("maxWeightKg must be greater than or equal to minWeightKg") as Error & {
      statusCode: number;
    };
    err.statusCode = 400;
    throw err;
  }

  const legSequence = intOrNull(input.legSequence);
  if (Number.isNaN(legSequence) || (legSequence != null && legSequence <= 0)) {
    const err = new Error("legSequence must be a positive integer") as Error & {
      statusCode: number;
    };
    err.statusCode = 400;
    throw err;
  }

  return {
    name,
    code: normalizeOptionalCode(input.code),
    providerId: String(input.providerId || "").trim(),
    fallbackProviderId: String(input.fallbackProviderId || "").trim() || null,
    routeTemplateId: String(input.routeTemplateId || "").trim() || null,
    routeTemplateLegId: String(input.routeTemplateLegId || "").trim() || null,
    isActive: boolOrDefault(input.isActive, true),
    priority: Math.trunc(priority),
    autoBook: boolOrDefault(input.autoBook, true),
    serviceType: input.serviceType ?? null,
    transportMode: input.transportMode ?? null,
    originCountryCode: normalizeCountryCode(input.originCountryCode),
    destinationCountryCode: normalizeCountryCode(input.destinationCountryCode),
    minWeightKg,
    maxWeightKg,
    legSequence,
    conditionsJson: input.conditionsJson === undefined ? undefined : input.conditionsJson,
  };
}

export async function listCarrierRoutingRulesForActor(args: {
  user: AuthUser;
  filters?: CarrierRoutingRuleFilters;
}) {
  await authorize(args.user, "integration.routing.read");
  const scopedIds = await listAccessibleCompanyIds(args.user);
  const filters = args.filters ?? {};
  if (filters.companyId && scopedIds !== null && !scopedIds.includes(filters.companyId)) {
    const err = new Error("Forbidden for this company") as Error & { statusCode: number };
    err.statusCode = 403;
    throw err;
  }
  if (scopedIds !== null && scopedIds.length === 0) return [];

  const q = filters.q?.trim();
  const limit = Math.min(Math.max(Number(filters.limit ?? 0), 1), 100);
  const usePagination = Boolean(filters.limit);
  const where = {
      ...(filters.companyId
        ? { companyId: filters.companyId }
        : scopedIds === null
          ? {}
          : { companyId: { in: scopedIds } }),
      ...(filters.providerId ? { providerId: filters.providerId } : {}),
      ...(filters.routeTemplateId ? { routeTemplateId: filters.routeTemplateId } : {}),
      ...(typeof filters.isActive === "boolean" ? { isActive: filters.isActive } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { code: { contains: q, mode: "insensitive" } },
              { originCountryCode: { contains: q, mode: "insensitive" } },
              { destinationCountryCode: { contains: q, mode: "insensitive" } },
              { provider: { providerCode: { contains: q, mode: "insensitive" } } },
              { routeTemplate: { name: { contains: q, mode: "insensitive" } } },
              { routeTemplate: { code: { contains: q, mode: "insensitive" } } },
            ],
          }
        : {}),
  };

  const rows = await db.carrierRoutingRule.findMany({
    where,
    include: {
      provider: { select: { providerCode: true, environment: true } },
      fallbackProvider: { select: { providerCode: true, environment: true } },
      routeTemplate: { select: { name: true, code: true } },
      routeTemplateLeg: { select: { legCode: true, sequence: true } },
    },
    orderBy: [{ companyId: "asc" }, { priority: "desc" }, { createdAt: "asc" }],
    ...(usePagination
      ? {
          take: limit + 1,
          ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
        }
      : {}),
  });
  if (!usePagination) return rows.map(mapRuleRow);

  const pageRows = rows.slice(0, limit);
  const hasNextPage = rows.length > limit;
  const total = await db.carrierRoutingRule.count({ where });
  return {
    data: pageRows.map(mapRuleRow),
    total,
    pageInfo: {
      limit,
      hasNextPage,
      nextCursor: hasNextPage ? pageRows[pageRows.length - 1]?.id ?? null : null,
    },
  };
}

export async function createCarrierRoutingRuleForActor(args: {
  user: AuthUser;
  input: CarrierRoutingRuleInput;
}) {
  await assertCompanyAccess(args.user, args.input.companyId, "integration.routing.manage");
  const normalized = normalizeRuleInput(args.input);
  if (!normalized.providerId) {
    const err = new Error("providerId is required") as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  await assertCarrierProviderForCompany({
    providerId: normalized.providerId,
    companyId: args.input.companyId,
    fieldName: "providerId",
  });
  await assertCarrierProviderForCompany({
    providerId: normalized.fallbackProviderId,
    companyId: args.input.companyId,
    fieldName: "fallbackProviderId",
  });
  await assertRouteTemplateForCompany({
    companyId: args.input.companyId,
    routeTemplateId: normalized.routeTemplateId,
    routeTemplateLegId: normalized.routeTemplateLegId,
  });

  const row = await db.carrierRoutingRule.create({
    data: {
      companyId: args.input.companyId,
      providerId: normalized.providerId,
      fallbackProviderId: normalized.fallbackProviderId,
      routeTemplateId: normalized.routeTemplateId,
      routeTemplateLegId: normalized.routeTemplateLegId,
      name: normalized.name,
      code: normalized.code,
      isActive: normalized.isActive,
      priority: normalized.priority,
      autoBook: normalized.autoBook,
      serviceType: normalized.serviceType,
      transportMode: normalized.transportMode,
      originCountryCode: normalized.originCountryCode,
      destinationCountryCode: normalized.destinationCountryCode,
      minWeightKg:
        normalized.minWeightKg == null ? null : new Prisma.Decimal(normalized.minWeightKg),
      maxWeightKg:
        normalized.maxWeightKg == null ? null : new Prisma.Decimal(normalized.maxWeightKg),
      legSequence: normalized.legSequence,
      conditionsJson:
        normalized.conditionsJson === undefined
          ? undefined
          : (normalized.conditionsJson as Prisma.InputJsonValue),
      createdByUserId: args.user.id,
      updatedByUserId: args.user.id,
    },
    include: {
      provider: { select: { providerCode: true, environment: true } },
      fallbackProvider: { select: { providerCode: true, environment: true } },
      routeTemplate: { select: { name: true, code: true } },
      routeTemplateLeg: { select: { legCode: true, sequence: true } },
    },
  });
  return mapRuleRow(row);
}

export async function updateCarrierRoutingRuleForActor(args: {
  user: AuthUser;
  ruleId: string;
  input: Partial<CarrierRoutingRuleInput>;
}) {
  const existing = await getRuleAccessibleOrThrow(
    args.user,
    args.ruleId,
    "integration.routing.manage",
  );
  const merged = {
    companyId: existing.companyId,
    name: args.input.name ?? existing.name,
    code: args.input.code === undefined ? existing.code : args.input.code,
    providerId: args.input.providerId ?? existing.providerId,
    fallbackProviderId:
      args.input.fallbackProviderId === undefined
        ? existing.fallbackProviderId
        : args.input.fallbackProviderId,
    routeTemplateId:
      args.input.routeTemplateId === undefined
        ? existing.routeTemplateId
        : args.input.routeTemplateId,
    routeTemplateLegId:
      args.input.routeTemplateLegId === undefined
        ? existing.routeTemplateLegId
        : args.input.routeTemplateLegId,
    isActive: args.input.isActive ?? existing.isActive,
    priority: args.input.priority ?? existing.priority,
    autoBook: args.input.autoBook ?? existing.autoBook,
    serviceType: args.input.serviceType === undefined ? existing.serviceType : args.input.serviceType,
    transportMode:
      args.input.transportMode === undefined ? existing.transportMode : args.input.transportMode,
    originCountryCode:
      args.input.originCountryCode === undefined
        ? existing.originCountryCode
        : args.input.originCountryCode,
    destinationCountryCode:
      args.input.destinationCountryCode === undefined
        ? existing.destinationCountryCode
        : args.input.destinationCountryCode,
    minWeightKg:
      args.input.minWeightKg === undefined
        ? existing.minWeightKg == null
          ? null
          : Number(existing.minWeightKg)
        : args.input.minWeightKg,
    maxWeightKg:
      args.input.maxWeightKg === undefined
        ? existing.maxWeightKg == null
          ? null
          : Number(existing.maxWeightKg)
        : args.input.maxWeightKg,
    legSequence: args.input.legSequence === undefined ? existing.legSequence : args.input.legSequence,
    conditionsJson:
      args.input.conditionsJson === undefined ? existing.conditionsJson : args.input.conditionsJson,
  } satisfies CarrierRoutingRuleInput;

  const normalized = normalizeRuleInput(merged);
  await assertCarrierProviderForCompany({
    providerId: normalized.providerId,
    companyId: existing.companyId,
    fieldName: "providerId",
  });
  await assertCarrierProviderForCompany({
    providerId: normalized.fallbackProviderId,
    companyId: existing.companyId,
    fieldName: "fallbackProviderId",
  });
  await assertRouteTemplateForCompany({
    companyId: existing.companyId,
    routeTemplateId: normalized.routeTemplateId,
    routeTemplateLegId: normalized.routeTemplateLegId,
  });

  const row = await db.carrierRoutingRule.update({
    where: { id: existing.id },
    data: {
      providerId: normalized.providerId,
      fallbackProviderId: normalized.fallbackProviderId,
      routeTemplateId: normalized.routeTemplateId,
      routeTemplateLegId: normalized.routeTemplateLegId,
      name: normalized.name,
      code: normalized.code,
      isActive: normalized.isActive,
      priority: normalized.priority,
      autoBook: normalized.autoBook,
      serviceType: normalized.serviceType,
      transportMode: normalized.transportMode,
      originCountryCode: normalized.originCountryCode,
      destinationCountryCode: normalized.destinationCountryCode,
      minWeightKg:
        normalized.minWeightKg == null ? null : new Prisma.Decimal(normalized.minWeightKg),
      maxWeightKg:
        normalized.maxWeightKg == null ? null : new Prisma.Decimal(normalized.maxWeightKg),
      legSequence: normalized.legSequence,
      conditionsJson:
        normalized.conditionsJson === undefined
          ? undefined
          : (normalized.conditionsJson as Prisma.InputJsonValue),
      updatedByUserId: args.user.id,
    },
    include: {
      provider: { select: { providerCode: true, environment: true } },
      fallbackProvider: { select: { providerCode: true, environment: true } },
      routeTemplate: { select: { name: true, code: true } },
      routeTemplateLeg: { select: { legCode: true, sequence: true } },
    },
  });
  return mapRuleRow(row);
}

export async function deleteCarrierRoutingRuleForActor(args: {
  user: AuthUser;
  ruleId: string;
}) {
  const existing = await getRuleAccessibleOrThrow(
    args.user,
    args.ruleId,
    "integration.routing.manage",
  );
  await db.carrierRoutingRule.delete({ where: { id: existing.id } });
  return { deleted: true, id: existing.id };
}

function resolveLegOriginCountry(leg: any) {
  return (
    normalizeCountryCode(leg.fromCountry) ||
    normalizeCountryCode(leg.order?.senderAddressObj?.country)
  );
}

function resolveLegDestinationCountry(leg: any) {
  return (
    normalizeCountryCode(leg.toCountry) ||
    normalizeCountryCode(leg.order?.receiverAddressObj?.country)
  );
}

export async function resolveCarrierRoutingRuleForOrderLeg(args: {
  companyId: string;
  orderId: string;
  legId: string;
}): Promise<ResolvedCarrierRoutingRule | null> {
  const companyId = String(args.companyId || "").trim();
  if (!companyId) return null;

  const leg = await db.orderLeg.findFirst({
    where: { id: args.legId, orderId: args.orderId },
    include: {
      order: {
        select: {
          id: true,
          serviceType: true,
          weightKg: true,
          ownerOrgId: true,
          assignedOrgId: true,
          senderAddressObj: { select: { country: true } },
          receiverAddressObj: { select: { country: true } },
        },
      },
    },
  });
  if (!leg) return null;
  const orderOrgIds = [leg.order.ownerOrgId, leg.order.assignedOrgId].filter(Boolean);
  if (orderOrgIds.length > 0 && !orderOrgIds.includes(companyId)) return null;

  const originCountryCode = resolveLegOriginCountry(leg);
  const destinationCountryCode = resolveLegDestinationCountry(leg);
  const weightKg = Number(leg.order.weightKg ?? NaN);
  const hasWeight = Number.isFinite(weightKg) && weightKg > 0;

  const rows = await db.carrierRoutingRule.findMany({
    where: {
      companyId,
      isActive: true,
      provider: {
        domain: "carrier",
        status: "active",
      },
      OR: [{ serviceType: null }, { serviceType: leg.order.serviceType }],
      AND: [
        { OR: [{ transportMode: null }, { transportMode: leg.mode }] },
        { OR: [{ legSequence: null }, { legSequence: leg.sequence }] },
        {
          OR: [
            { originCountryCode: null },
            ...(originCountryCode ? [{ originCountryCode }] : []),
          ],
        },
        {
          OR: [
            { destinationCountryCode: null },
            ...(destinationCountryCode ? [{ destinationCountryCode }] : []),
          ],
        },
        {
          OR: [
            { routeTemplateId: null },
            ...(leg.routeTemplateId ? [{ routeTemplateId: leg.routeTemplateId }] : []),
          ],
        },
        {
          OR: [
            { routeTemplateLegId: null },
            ...(leg.routeTemplateLegId ? [{ routeTemplateLegId: leg.routeTemplateLegId }] : []),
          ],
        },
        hasWeight ? { OR: [{ minWeightKg: null }, { minWeightKg: { lte: weightKg } }] } : { minWeightKg: null },
        hasWeight ? { OR: [{ maxWeightKg: null }, { maxWeightKg: { gte: weightKg } }] } : { maxWeightKg: null },
      ],
    },
    include: {
      provider: {
        select: {
          id: true,
          providerCode: true,
          environment: true,
        },
      },
    },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    take: 1,
  });

  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.companyId,
    providerId: row.providerId,
    providerCode: row.provider.providerCode,
    providerEnvironment: row.provider.environment,
    fallbackProviderId: row.fallbackProviderId ?? null,
    name: row.name,
    code: row.code ?? null,
    priority: Number(row.priority ?? 0),
    autoBook: Boolean(row.autoBook),
  };
}
