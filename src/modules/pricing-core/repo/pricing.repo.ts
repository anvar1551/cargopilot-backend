import prisma from "../../../config/prismaClient";
import { OrderSlaSource, OrderStatus, ServiceType } from "@prisma/client";
import { orderError } from "../../orders-core/shared";
import { resolveOrderSlaSnapshot as resolveOrderSlaSnapshotForOrder } from "../../orders-core/sla";
import {
  CreateDeliverySlaRuleInput,
  CreatePricingRegionInput,
  CreateTariffPlanInput,
  QuoteTariffInput,
  QuoteTariffOptionsInput,
  TARIFF_COVERAGE_TYPES,
  TARIFF_PRICING_STRATEGIES,
  TARIFF_TRANSPORT_MODES,
  UpdateOperationalSlaPolicyInput,
  UpdateDeliverySlaRuleInput,
  UpdatePricingRegionInput,
  UpdateTariffPlanInput,
  UpsertZoneMatrixInput,
  normalizeCountryCode,
  normalizeTariffCode,
} from "../shared/validation";

const db = prisma as any;
const OPERATIONAL_SLA_POLICY_KEY = "global";

const ACTIVE_ORDER_STATUSES_FOR_SLA_BACKFILL: OrderStatus[] = [
  OrderStatus.pending,
  OrderStatus.assigned,
  OrderStatus.pickup_in_progress,
  OrderStatus.picked_up,
  OrderStatus.at_warehouse,
  OrderStatus.in_transit,
  OrderStatus.out_for_delivery,
  OrderStatus.exception,
  OrderStatus.return_in_progress,
];

function normalizeRegionQuery(value?: string | null) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function matchesRegion(
  region: { code?: string; name?: string; aliases?: string[] },
  query?: string | null,
) {
  const normalizedQuery = normalizeRegionQuery(query);
  if (!normalizedQuery) return false;

  const candidates = [
    region.code,
    region.name,
    ...(Array.isArray(region.aliases) ? region.aliases : []),
  ]
    .map((value) => normalizeRegionQuery(value))
    .filter(Boolean);

  return candidates.includes(normalizedQuery);
}

function toNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundTo2(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

type TransitLegRateConfig = {
  sequence: number;
  legCode: string;
  label: string | null;
  mode: string | null;
  originCountryCode: string | null;
  destinationCountryCode: string | null;
  ratePerKg: number;
  minCharge: number;
  flatFee: number;
};

function normalizeTransitLegRates(raw: unknown): TransitLegRateConfig[] {
  if (!raw || typeof raw !== "object") return [];
  const value = raw as { legs?: unknown };
  if (!Array.isArray(value.legs)) return [];

  return value.legs
    .map((leg) => {
      if (!leg || typeof leg !== "object") return null;
      const item = leg as Record<string, unknown>;
      const sequence = Number(item.sequence);
      const legCode = String(item.legCode ?? "")
        .trim()
        .toLowerCase();
      const ratePerKg = toNumber(item.ratePerKg);
      if (
        !Number.isInteger(sequence) ||
        sequence < 1 ||
        !legCode ||
        ratePerKg === null ||
        ratePerKg < 0
      ) {
        return null;
      }

      const minCharge = Math.max(0, toNumber(item.minCharge) ?? 0);
      const flatFee = Math.max(0, toNumber(item.flatFee) ?? 0);
      return {
        sequence,
        legCode,
        label: item.label ? String(item.label).trim() || null : null,
        mode: item.mode ? String(item.mode).trim().toUpperCase() || null : null,
        originCountryCode: normalizeCountryCode(item.originCountryCode as string | null),
        destinationCountryCode: normalizeCountryCode(
          item.destinationCountryCode as string | null,
        ),
        ratePerKg,
        minCharge,
        flatFee,
      };
    })
    .filter((item): item is TransitLegRateConfig => Boolean(item))
    .sort((left, right) => left.sequence - right.sequence);
}

function resolveTransitLegCharge(weightKg: number, leg: TransitLegRateConfig) {
  const variable = roundTo2(weightKg * leg.ratePerKg);
  return roundTo2(Math.max(variable, leg.minCharge) + leg.flatFee);
}

function resolveCoverageType(params: {
  originCountryCode?: string | null;
  destinationCountryCode?: string | null;
}) {
  const origin = normalizeCountryCode(params.originCountryCode);
  const destination = normalizeCountryCode(params.destinationCountryCode);
  if (origin && destination && origin !== destination) return "international" as const;
  return "domestic" as const;
}

function isCountryMatch(
  planCountryCode: string | null | undefined,
  quoteCountryCode: string | null | undefined,
) {
  if (!planCountryCode) return true;
  if (!quoteCountryCode) return false;
  return planCountryCode.trim().toUpperCase() === quoteCountryCode.trim().toUpperCase();
}

type TariffPlanForQuote = {
  id: string;
  name: string;
  code?: string | null;
  routeTemplateId?: string | null;
  pricingStrategy: "FIXED_LANE" | "LEG_TRANSIT";
  transitPricingConfig?: unknown;
  coverageType: "domestic" | "international";
  currency: string;
  priceType: string;
  customerEntityId?: string | null;
  isDefault?: boolean;
  priority?: number;
  createdAt?: Date;
  rates: Array<{
    id: string;
    zone: number;
    weightFromKg: unknown;
    weightToKg: unknown;
    price: unknown;
  }>;
};

function sortTariffPlans(
  plans: TariffPlanForQuote[],
  customerEntityId?: string | null,
) {
  return [...plans].sort((left, right) => {
    const leftSpecific = left.customerEntityId && left.customerEntityId === customerEntityId ? 1 : 0;
    const rightSpecific = right.customerEntityId && right.customerEntityId === customerEntityId ? 1 : 0;
    if (leftSpecific !== rightSpecific) return rightSpecific - leftSpecific;

    const leftDefault = left.isDefault ? 1 : 0;
    const rightDefault = right.isDefault ? 1 : 0;
    if (leftDefault !== rightDefault) return rightDefault - leftDefault;

    const leftPriority = Number(left.priority ?? 0);
    const rightPriority = Number(right.priority ?? 0);
    if (leftPriority !== rightPriority) return rightPriority - leftPriority;

    return new Date(right.createdAt ?? 0).getTime() - new Date(left.createdAt ?? 0).getTime();
  });
}

async function assertRouteTemplateExists(routeTemplateId?: string | null) {
  if (!routeTemplateId) return;
  const routeTemplate = await db.routeTemplate.findUnique({
    where: { id: routeTemplateId },
    select: { id: true },
  });
  if (!routeTemplate) {
    throw orderError("routeTemplateId not found", 400);
  }
}

type PricingRegionLite = {
  id: string;
  code: string;
  name: string;
  aliases?: string[];
};

type PricingZoneLite = {
  zone: number;
};

type PricingRouteContext = {
  originRegion: PricingRegionLite | null;
  destinationRegion: PricingRegionLite | null;
  zoneEntry: PricingZoneLite | null;
  reason:
    | "missing_required_fields"
    | "origin_region_not_found"
    | "destination_region_not_found"
    | "zone_not_found"
    | null;
};

type DeliverySlaRuleForMatch = {
  id: string;
  originRegionId?: string | null;
  destinationRegionId?: string | null;
  zone?: number | null;
  priority?: number | null;
  createdAt?: Date;
  deliveryDays: number;
};

function toDateOrNull(value?: Date | string | null) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function addDaysUtc(baseDate: Date, days: number) {
  const next = new Date(baseDate);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

async function ensurePricingRegionExists(id: string) {
  const region = await db.pricingRegion.findUnique({
    where: { id },
    select: { id: true },
  });

  if (!region) {
    throw orderError(`pricingRegionId not found: ${id}`, 400);
  }
}

async function assertDeliverySlaRuleReferences(
  input: Pick<CreateDeliverySlaRuleInput, "originRegionId" | "destinationRegionId">,
) {
  if (input.originRegionId) await ensurePricingRegionExists(input.originRegionId);
  if (input.destinationRegionId) {
    await ensurePricingRegionExists(input.destinationRegionId);
  }
}

async function loadActivePricingRegions() {
  return db.pricingRegion.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}

async function resolvePricingRouteContext(params: {
  originQuery?: string | null;
  destinationQuery?: string | null;
}): Promise<PricingRouteContext> {
  const originQuery = params.originQuery?.trim() ?? "";
  const destinationQuery = params.destinationQuery?.trim() ?? "";

  if (!originQuery || !destinationQuery) {
    return {
      originRegion: null,
      destinationRegion: null,
      zoneEntry: null,
      reason: "missing_required_fields",
    };
  }

  const regions = await loadActivePricingRegions();
  const originRegion =
    regions.find((region: PricingRegionLite) => matchesRegion(region, originQuery)) ??
    null;
  const destinationRegion =
    regions.find((region: PricingRegionLite) =>
      matchesRegion(region, destinationQuery),
    ) ?? null;

  if (!originRegion) {
    return {
      originRegion: null,
      destinationRegion: null,
      zoneEntry: null,
      reason: "origin_region_not_found",
    };
  }

  if (!destinationRegion) {
    return {
      originRegion,
      destinationRegion: null,
      zoneEntry: null,
      reason: "destination_region_not_found",
    };
  }

  const zoneEntry = await db.zoneMatrixEntry.findUnique({
    where: {
      originRegionId_destinationRegionId: {
        originRegionId: originRegion.id,
        destinationRegionId: destinationRegion.id,
      },
    },
    select: { zone: true },
  });

  if (!zoneEntry) {
    return {
      originRegion,
      destinationRegion,
      zoneEntry: null,
      reason: "zone_not_found",
    };
  }

  return {
    originRegion,
    destinationRegion,
    zoneEntry,
    reason: null,
  };
}

function rankDeliverySlaRule(
  rule: DeliverySlaRuleForMatch,
  routeContext: PricingRouteContext,
) {
  const isExactRoute =
    Boolean(rule.originRegionId) &&
    Boolean(rule.destinationRegionId) &&
    rule.originRegionId === routeContext.originRegion?.id &&
    rule.destinationRegionId === routeContext.destinationRegion?.id;

  if (isExactRoute) return 3;

  const isZoneRule =
    rule.zone !== null &&
    rule.zone !== undefined &&
    routeContext.zoneEntry?.zone !== undefined &&
    rule.zone === routeContext.zoneEntry.zone &&
    !rule.originRegionId &&
    !rule.destinationRegionId;

  if (isZoneRule) return 2;

  const isServiceDefault =
    (rule.zone === null || rule.zone === undefined) &&
    !rule.originRegionId &&
    !rule.destinationRegionId;

  if (isServiceDefault) return 1;

  return 0;
}

function pickBestDeliverySlaRule(
  rules: DeliverySlaRuleForMatch[],
  routeContext: PricingRouteContext,
) {
  return [...rules].sort((left, right) => {
    const leftRank = rankDeliverySlaRule(left, routeContext);
    const rightRank = rankDeliverySlaRule(right, routeContext);
    if (leftRank !== rightRank) return rightRank - leftRank;

    const leftPriority = Number(left.priority ?? 0);
    const rightPriority = Number(right.priority ?? 0);
    if (leftPriority !== rightPriority) return rightPriority - leftPriority;

    return new Date(right.createdAt ?? 0).getTime() - new Date(left.createdAt ?? 0).getTime();
  })[0] ?? null;
}

export async function createPricingRegion(input: CreatePricingRegionInput) {
  return db.pricingRegion.create({
    data: {
      code: input.code,
      name: input.name,
      aliases: input.aliases,
      sortOrder: input.sortOrder,
      isActive: input.isActive,
    },
  });
}

export async function updatePricingRegion(
  id: string,
  input: UpdatePricingRegionInput,
) {
  const existing = await db.pricingRegion.findUnique({
    where: { id },
    select: { id: true },
  });

  if (!existing) {
    throw orderError("Pricing region not found", 404);
  }

  return db.pricingRegion.update({
    where: { id },
    data: {
      code: input.code,
      name: input.name,
      aliases: input.aliases,
      sortOrder: input.sortOrder,
      isActive: input.isActive,
    },
  });
}

export async function deletePricingRegion(id: string) {
  const existing = await db.pricingRegion.findUnique({
    where: { id },
    select: { id: true, name: true },
  });

  if (!existing) {
    throw orderError("Pricing region not found", 404);
  }

  return db.$transaction(async (tx: any) => {
    const relatedSlaRules = await tx.deliverySlaRule.findMany({
      where: {
        OR: [{ originRegionId: id }, { destinationRegionId: id }],
      },
      select: { id: true },
    });
    const relatedSlaRuleIds = relatedSlaRules.map((rule: { id: string }) => rule.id);

    const ordersDetached = relatedSlaRuleIds.length
      ? (
          await tx.order.updateMany({
            where: { slaRuleId: { in: relatedSlaRuleIds } },
            data: { slaRuleId: null },
          })
        ).count
      : 0;

    const slaRulesDeleted = relatedSlaRuleIds.length
      ? (
          await tx.deliverySlaRule.deleteMany({
            where: { id: { in: relatedSlaRuleIds } },
          })
        ).count
      : 0;

    const zoneEntriesDeleted = (
      await tx.zoneMatrixEntry.deleteMany({
        where: {
          OR: [{ originRegionId: id }, { destinationRegionId: id }],
        },
      })
    ).count;

    await tx.pricingRegion.delete({ where: { id } });

    return {
      deleted: true,
      id,
      name: existing.name,
      cleanup: {
        zoneEntriesDeleted,
        slaRulesDeleted,
        ordersDetached,
      },
    };
  });
}

export async function createDeliverySlaRule(input: CreateDeliverySlaRuleInput) {
  await assertDeliverySlaRuleReferences(input);

  return db.deliverySlaRule.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      serviceType: input.serviceType,
      originRegionId: input.originRegionId ?? null,
      destinationRegionId: input.destinationRegionId ?? null,
      zone: input.zone ?? null,
      deliveryDays: input.deliveryDays,
      priority: input.priority,
      isActive: input.isActive,
    },
    include: {
      originRegion: true,
      destinationRegion: true,
    },
  });
}

export async function updateDeliverySlaRule(
  id: string,
  input: UpdateDeliverySlaRuleInput,
) {
  const existing = await db.deliverySlaRule.findUnique({
    where: { id },
    select: { id: true },
  });

  if (!existing) {
    throw orderError("Delivery SLA rule not found", 404);
  }

  await assertDeliverySlaRuleReferences(input);

  return db.deliverySlaRule.update({
    where: { id },
    data: {
      name: input.name,
      description: input.description ?? null,
      serviceType: input.serviceType,
      originRegionId: input.originRegionId ?? null,
      destinationRegionId: input.destinationRegionId ?? null,
      zone: input.zone ?? null,
      deliveryDays: input.deliveryDays,
      priority: input.priority,
      isActive: input.isActive,
    },
    include: {
      originRegion: true,
      destinationRegion: true,
    },
  });
}

export async function deleteDeliverySlaRule(id: string) {
  const existing = await db.deliverySlaRule.findUnique({
    where: { id },
    select: { id: true, name: true },
  });

  if (!existing) {
    throw orderError("Delivery SLA rule not found", 404);
  }

  return db.$transaction(async (tx: any) => {
    const ordersDetached = (
      await tx.order.updateMany({
        where: { slaRuleId: id },
        data: { slaRuleId: null },
      })
    ).count;

    await tx.deliverySlaRule.delete({ where: { id } });

    return {
      deleted: true,
      id,
      name: existing.name,
      cleanup: { ordersDetached },
    };
  });
}

export async function listDeliverySlaRules(params: {
  q?: string;
  serviceType?: string;
  isActive?: boolean;
  cursor?: string;
  limit?: number;
}) {
  const q = params.q?.trim();
  const limit = Math.min(Math.max(Number(params.limit ?? 0), 1), 100);
  const usePagination = Boolean(params.limit);
  const where = {
    ...(typeof params.isActive === "boolean"
      ? { isActive: params.isActive }
      : {}),
    ...(params.serviceType ? { serviceType: params.serviceType } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { description: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const rows = await db.deliverySlaRule.findMany({
    where,
    include: {
      originRegion: true,
      destinationRegion: true,
    },
    orderBy: [
      { serviceType: "asc" },
      { priority: "desc" },
      { createdAt: "desc" },
    ],
    ...(usePagination
      ? {
          take: limit + 1,
          ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
        }
      : {}),
  });
  if (!usePagination) return rows;

  const pageRows = rows.slice(0, limit);
  const hasNextPage = rows.length > limit;
  const total = await db.deliverySlaRule.count({ where });
  return {
    data: pageRows,
    total,
    pageInfo: {
      limit,
      hasNextPage,
      nextCursor: hasNextPage ? pageRows[pageRows.length - 1]?.id ?? null : null,
    },
  };
}

export async function getOperationalSlaPolicy() {
  return db.operationalSlaPolicy.upsert({
    where: { singletonKey: OPERATIONAL_SLA_POLICY_KEY },
    update: {},
    create: {
      singletonKey: OPERATIONAL_SLA_POLICY_KEY,
      staleHours: 48,
      dueSoonHours: 24,
      overdueGraceHours: 0,
    },
  });
}

export async function updateOperationalSlaPolicy(
  input: UpdateOperationalSlaPolicyInput,
) {
  return db.operationalSlaPolicy.upsert({
    where: { singletonKey: OPERATIONAL_SLA_POLICY_KEY },
    update: {
      staleHours: input.staleHours,
      dueSoonHours: input.dueSoonHours,
      overdueGraceHours: input.overdueGraceHours,
    },
    create: {
      singletonKey: OPERATIONAL_SLA_POLICY_KEY,
      staleHours: input.staleHours,
      dueSoonHours: input.dueSoonHours,
      overdueGraceHours: input.overdueGraceHours,
    },
  });
}

export async function listPricingRegions(params: {
  q?: string;
  isActive?: boolean;
  cursor?: string;
  limit?: number;
}) {
  const q = params.q?.trim();
  const limit = Math.min(Math.max(Number(params.limit ?? 0), 1), 100);
  const usePagination = Boolean(params.limit);
  const where = {
    ...(typeof params.isActive === "boolean"
      ? { isActive: params.isActive }
      : {}),
    ...(q
      ? {
          OR: [
            { code: { contains: q, mode: "insensitive" } },
            { name: { contains: q, mode: "insensitive" } },
            { aliases: { has: q } },
          ],
        }
      : {}),
  };

  const rows = await db.pricingRegion.findMany({
    where,
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    ...(usePagination
      ? {
          take: limit + 1,
          ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
        }
      : {}),
  });
  if (!usePagination) return rows;

  const pageRows = rows.slice(0, limit);
  const hasNextPage = rows.length > limit;
  const total = await db.pricingRegion.count({ where });
  return {
    data: pageRows,
    total,
    pageInfo: {
      limit,
      hasNextPage,
      nextCursor: hasNextPage ? pageRows[pageRows.length - 1]?.id ?? null : null,
    },
  };
}

export async function upsertZoneMatrix(input: UpsertZoneMatrixInput) {
  const regionIds = Array.from(
    new Set(
      input.entries.flatMap((entry) => [
        entry.originRegionId,
        entry.destinationRegionId,
      ]),
    ),
  );

  const regions = await db.pricingRegion.findMany({
    where: { id: { in: regionIds } },
    select: { id: true },
  });

  const missingRegionIds = regionIds.filter(
    (id) => !regions.some((region: { id: string }) => region.id === id),
  );

  if (missingRegionIds.length > 0) {
    throw orderError(
      `Unknown pricingRegionId: ${missingRegionIds.join(", ")}`,
      400,
    );
  }

  await db.$transaction(
    input.entries.map((entry) =>
      db.zoneMatrixEntry.upsert({
        where: {
          originRegionId_destinationRegionId: {
            originRegionId: entry.originRegionId,
            destinationRegionId: entry.destinationRegionId,
          },
        },
        update: {
          zone: entry.zone,
        },
        create: {
          originRegionId: entry.originRegionId,
          destinationRegionId: entry.destinationRegionId,
          zone: entry.zone,
        },
      }),
    ),
  );

  return listZoneMatrix({});
}

export async function listZoneMatrix(params: {
  originRegionId?: string;
  destinationRegionId?: string;
}) {
  return db.zoneMatrixEntry.findMany({
    where: {
      ...(params.originRegionId
        ? { originRegionId: params.originRegionId }
        : {}),
      ...(params.destinationRegionId
        ? { destinationRegionId: params.destinationRegionId }
        : {}),
    },
    include: {
      originRegion: true,
      destinationRegion: true,
    },
    orderBy: [
      { originRegion: { sortOrder: "asc" } },
      { destinationRegion: { sortOrder: "asc" } },
    ],
  });
}

export async function createTariffPlan(input: CreateTariffPlanInput) {
  await assertRouteTemplateExists(input.routeTemplateId ?? null);

  if (input.customerEntityId) {
    const customerEntity = await db.customerEntity.findUnique({
      where: { id: input.customerEntityId },
      select: { id: true },
    });

    if (!customerEntity) {
      throw orderError("customerEntityId not found", 400);
    }
  }

  const normalizedOriginCountryCode =
    input.coverageType === "international"
      ? normalizeCountryCode(input.originCountryCode)
      : null;
  const normalizedDestinationCountryCode =
    input.coverageType === "international"
      ? normalizeCountryCode(input.destinationCountryCode)
      : null;

  return db.$transaction(async (tx: any) => {
    if (input.isDefault) {
      await tx.tariffPlan.updateMany({
        where: {
          serviceType: input.serviceType,
          coverageType: input.coverageType,
          transportMode: input.transportMode,
          originCountryCode: normalizedOriginCountryCode,
          destinationCountryCode: normalizedDestinationCountryCode,
          customerEntityId: input.customerEntityId ?? null,
          isDefault: true,
        },
        data: { isDefault: false },
      });
    }

    return tx.tariffPlan.create({
      data: {
        name: input.name,
        code: normalizeTariffCode(input.code),
        description: input.description ?? null,
        status: input.status,
        serviceType: input.serviceType,
        priceType: input.priceType,
        pricingStrategy: input.pricingStrategy,
        coverageType: input.coverageType,
        transportMode: input.transportMode,
        originCountryCode: normalizedOriginCountryCode,
        destinationCountryCode: normalizedDestinationCountryCode,
        routeTemplateId: input.routeTemplateId ?? null,
        transitPricingConfig:
          input.pricingStrategy === "LEG_TRANSIT"
            ? { legs: input.transitLegRates ?? [] }
            : null,
        currency: input.currency.toUpperCase(),
        priority: input.priority,
        isDefault: input.isDefault,
        customerEntityId: input.customerEntityId ?? null,
        rates: {
          create: input.rates.map((rate) => ({
            zone: rate.zone,
            weightFromKg: rate.weightFromKg,
            weightToKg: rate.weightToKg,
            price: rate.price,
          })),
        },
      },
      include: {
        customerEntity: {
          select: { id: true, name: true, type: true },
        },
        routeTemplate: {
          select: { id: true, name: true, code: true, companyId: true },
        },
        rates: {
          orderBy: [{ zone: "asc" }, { weightFromKg: "asc" }],
        },
      },
    });
  });
}

export async function updateTariffPlan(id: string, input: UpdateTariffPlanInput) {
  await assertRouteTemplateExists(input.routeTemplateId ?? null);

  const existing = await db.tariffPlan.findUnique({
    where: { id },
    select: {
      id: true,
      isDefault: true,
    },
  });

  if (!existing) {
    throw orderError("Tariff plan not found", 404);
  }

  if (input.customerEntityId) {
    const customerEntity = await db.customerEntity.findUnique({
      where: { id: input.customerEntityId },
      select: { id: true },
    });

    if (!customerEntity) {
      throw orderError("customerEntityId not found", 400);
    }
  }

  const normalizedOriginCountryCode =
    input.coverageType === "international"
      ? normalizeCountryCode(input.originCountryCode)
      : null;
  const normalizedDestinationCountryCode =
    input.coverageType === "international"
      ? normalizeCountryCode(input.destinationCountryCode)
      : null;

  return db.$transaction(async (tx: any) => {
    if (input.isDefault) {
      await tx.tariffPlan.updateMany({
        where: {
          id: { not: id },
          serviceType: input.serviceType,
          coverageType: input.coverageType,
          transportMode: input.transportMode,
          originCountryCode: normalizedOriginCountryCode,
          destinationCountryCode: normalizedDestinationCountryCode,
          customerEntityId: input.customerEntityId ?? null,
          isDefault: true,
        },
        data: { isDefault: false },
      });
    }

    await tx.tariffRate.deleteMany({
      where: { tariffPlanId: id },
    });

    return tx.tariffPlan.update({
      where: { id },
      data: {
        name: input.name,
        code: normalizeTariffCode(input.code),
        description: input.description ?? null,
        status: input.status,
        serviceType: input.serviceType,
        priceType: input.priceType,
        pricingStrategy: input.pricingStrategy,
        coverageType: input.coverageType,
        transportMode: input.transportMode,
        originCountryCode: normalizedOriginCountryCode,
        destinationCountryCode: normalizedDestinationCountryCode,
        routeTemplateId: input.routeTemplateId ?? null,
        transitPricingConfig:
          input.pricingStrategy === "LEG_TRANSIT"
            ? { legs: input.transitLegRates ?? [] }
            : null,
        currency: input.currency.toUpperCase(),
        priority: input.priority,
        isDefault: input.isDefault,
        customerEntityId: input.customerEntityId ?? null,
        rates: {
          create: input.rates.map((rate) => ({
            zone: rate.zone,
            weightFromKg: rate.weightFromKg,
            weightToKg: rate.weightToKg,
            price: rate.price,
          })),
        },
      },
      include: {
        customerEntity: {
          select: { id: true, name: true, type: true },
        },
        routeTemplate: {
          select: { id: true, name: true, code: true, companyId: true },
        },
        rates: {
          orderBy: [{ zone: "asc" }, { weightFromKg: "asc" }],
        },
      },
    });
  });
}

export async function deleteTariffPlan(id: string) {
  const existing = await db.tariffPlan.findUnique({
    where: { id },
    select: { id: true, name: true },
  });

  if (!existing) {
    throw orderError("Tariff plan not found", 404);
  }

  return db.$transaction(async (tx: any) => {
    const ratesDeleted = (
      await tx.tariffRate.deleteMany({
        where: { tariffPlanId: id },
      })
    ).count;

    await tx.tariffPlan.delete({ where: { id } });

    return {
      deleted: true,
      id,
      name: existing.name,
      cleanup: { ratesDeleted },
    };
  });
}

export async function listTariffPlans(params: {
  status?: "draft" | "active" | "archived";
  serviceType?: string;
  pricingStrategy?: "FIXED_LANE" | "LEG_TRANSIT";
  coverageType?: "domestic" | "international";
  transportMode?: string;
  customerEntityId?: string;
  routeTemplateId?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}) {
  const q = params.q?.trim();
  const limit = Math.min(Math.max(Number(params.limit ?? 0), 1), 100);
  const usePagination = Boolean(params.limit);
  const where = {
    ...(params.status ? { status: params.status } : {}),
    ...(params.serviceType ? { serviceType: params.serviceType } : {}),
    ...(params.pricingStrategy
      ? { pricingStrategy: params.pricingStrategy }
      : {}),
    ...(params.coverageType ? { coverageType: params.coverageType } : {}),
    ...(params.transportMode
      ? { transportMode: params.transportMode.trim().toUpperCase() }
      : {}),
    ...(params.customerEntityId
      ? { customerEntityId: params.customerEntityId }
      : {}),
    ...(params.routeTemplateId ? { routeTemplateId: params.routeTemplateId } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { code: { contains: q, mode: "insensitive" } },
            { description: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const rows = await db.tariffPlan.findMany({
    where,
    include: {
      customerEntity: {
        select: { id: true, name: true, type: true },
      },
      routeTemplate: {
        select: { id: true, name: true, code: true, companyId: true },
      },
      _count: {
        select: { rates: true },
      },
    },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    ...(usePagination
      ? {
          take: limit + 1,
          ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
        }
      : {}),
  });
  if (!usePagination) return rows;

  const pageRows = rows.slice(0, limit);
  const hasNextPage = rows.length > limit;
  const total = await db.tariffPlan.count({ where });
  return {
    data: pageRows,
    total,
    pageInfo: {
      limit,
      hasNextPage,
      nextCursor: hasNextPage ? pageRows[pageRows.length - 1]?.id ?? null : null,
    },
  };
}

export async function getTariffPlanById(id: string) {
  return db.tariffPlan.findUnique({
    where: { id },
    include: {
      customerEntity: {
        select: { id: true, name: true, type: true },
      },
      routeTemplate: {
        include: {
          legs: {
            orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
          },
        },
      },
      rates: {
        orderBy: [{ zone: "asc" }, { weightFromKg: "asc" }],
      },
    },
  });
}

export async function getPricingCatalog() {
  return {
    coverageTypes: [...TARIFF_COVERAGE_TYPES],
    pricingStrategies: [...TARIFF_PRICING_STRATEGIES],
    transportModes: [...TARIFF_TRANSPORT_MODES],
  };
}

export async function resolveOrderSlaSnapshot(input: {
  serviceType?: ServiceType | string | null;
  originQuery?: string | null;
  destinationQuery?: string | null;
  promiseDate?: Date | string | null;
  createdAt?: Date;
}) {
  return resolveOrderSlaSnapshotForOrder(input);
}

export async function backfillOrderSlaSnapshots(input?: {
  limit?: number;
  dryRun?: boolean;
}) {
  const limit = Math.min(Math.max(Number(input?.limit ?? 500), 1), 5000);
  const dryRun = input?.dryRun !== false;

  const candidates = await db.order.findMany({
    where: {
      status: { in: ACTIVE_ORDER_STATUSES_FOR_SLA_BACKFILL },
      serviceType: { not: null },
      expectedDeliveryAt: null,
    },
    select: {
      id: true,
      createdAt: true,
      promiseDate: true,
      serviceType: true,
      destinationCity: true,
      senderAddressObj: {
        select: { city: true },
      },
      receiverAddressObj: {
        select: { city: true },
      },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  let updated = 0;
  let skipped = 0;
  let promiseBacked = 0;
  let ruleBacked = 0;
  let defaultBacked = 0;

  for (const order of candidates) {
    const snapshot = await resolveOrderSlaSnapshot({
      serviceType: order.serviceType,
      originQuery: order.senderAddressObj?.city ?? null,
      destinationQuery:
        order.destinationCity ?? order.receiverAddressObj?.city ?? null,
      promiseDate: order.promiseDate,
      createdAt: order.createdAt,
    });

    if (!snapshot.expectedDeliveryAt) {
      skipped += 1;
      continue;
    }

    if (snapshot.slaSource === OrderSlaSource.PROMISE_DATE) promiseBacked += 1;
    else if (snapshot.slaRuleId) {
      ruleBacked += 1;
    } else {
      defaultBacked += 1;
    }

    if (!dryRun) {
      await db.order.update({
        where: { id: order.id },
        data: {
          expectedDeliveryAt: snapshot.expectedDeliveryAt,
          slaSource: snapshot.slaSource,
          slaRuleId: snapshot.slaRuleId,
          slaTargetDays: snapshot.slaTargetDays,
        },
      });
    }

    updated += 1;
  }

  const remaining = await db.order.count({
    where: {
      status: { in: ACTIVE_ORDER_STATUSES_FOR_SLA_BACKFILL },
      serviceType: { not: null },
      expectedDeliveryAt: null,
    },
  });

  return {
    dryRun,
    limit,
    scanned: candidates.length,
    updated,
    skipped,
    remaining,
    sources: {
      promiseBacked,
      ruleBacked,
      defaultBacked,
    },
  };
}

export async function quoteTariff(input: QuoteTariffInput) {
  const weightKg = toNumber(input.weightKg);
  const originQuery = input.originQuery?.trim() ?? "";
  const destinationQuery = input.destinationQuery?.trim() ?? "";
  const originCountryCode = normalizeCountryCode(input.originCountryCode);
  const destinationCountryCode = normalizeCountryCode(input.destinationCountryCode);
  const inferredCoverageType = resolveCoverageType({
    originCountryCode,
    destinationCountryCode,
  });
  const hasBothCountries = Boolean(originCountryCode && destinationCountryCode);
  const coverageCandidates = hasBothCountries
    ? [inferredCoverageType]
    : (["domestic", "international"] as const);
  const transportMode = input.transportMode?.trim().toUpperCase() || "ROAD";

  if (!weightKg || !originQuery || !destinationQuery) {
    return {
      quoteAvailable: false,
      reason: "missing_required_fields",
      serviceType: input.serviceType,
    } as const;
  }

  const routeContext = await resolvePricingRouteContext({
    originQuery,
    destinationQuery,
  });

  if (routeContext.reason === "origin_region_not_found") {
    return {
      quoteAvailable: false,
      reason: "origin_region_not_found",
      serviceType: input.serviceType,
    } as const;
  }

  if (routeContext.reason === "destination_region_not_found") {
    return {
      quoteAvailable: false,
      reason: "destination_region_not_found",
      serviceType: input.serviceType,
    } as const;
  }

  if (routeContext.reason === "zone_not_found" || !routeContext.zoneEntry) {
    return {
      quoteAvailable: false,
      reason: "zone_not_found",
      serviceType: input.serviceType,
      originRegion: {
        id: routeContext.originRegion!.id,
        code: routeContext.originRegion!.code,
        name: routeContext.originRegion!.name,
      },
      destinationRegion: {
        id: routeContext.destinationRegion!.id,
        code: routeContext.destinationRegion!.code,
        name: routeContext.destinationRegion!.name,
      },
    } as const;
  }

  const plans = await db.tariffPlan.findMany({
    where: {
      status: "active",
      serviceType: input.serviceType as ServiceType,
      coverageType: { in: coverageCandidates as any },
      transportMode,
      OR: input.customerEntityId
        ? [{ customerEntityId: input.customerEntityId }, { customerEntityId: null }]
        : [{ customerEntityId: null }],
      ...(input.companyId
        ? {
            AND: [
              {
                OR: [
                  { routeTemplateId: null },
                  { routeTemplate: { companyId: input.companyId } },
                ],
              },
            ],
          }
        : {}),
    },
    include: {
      rates: {
        where: { zone: routeContext.zoneEntry.zone },
        orderBy: [{ weightFromKg: "asc" }, { weightToKg: "asc" }],
      },
    },
  });

  const filteredPlans = plans.filter((plan: any) => {
    if (plan.coverageType !== "international") return true;
    if (!hasBothCountries) return true;
    return (
      isCountryMatch(plan.originCountryCode, originCountryCode) &&
      isCountryMatch(plan.destinationCountryCode, destinationCountryCode)
    );
  });

  const plan = sortTariffPlans(filteredPlans, input.customerEntityId)[0] ?? null;
  if (!plan) {
    return {
      quoteAvailable: false,
      reason: "tariff_plan_not_found",
      serviceType: input.serviceType,
      originRegion: {
        id: routeContext.originRegion!.id,
        code: routeContext.originRegion!.code,
        name: routeContext.originRegion!.name,
      },
      destinationRegion: {
        id: routeContext.destinationRegion!.id,
        code: routeContext.destinationRegion!.code,
        name: routeContext.destinationRegion!.name,
      },
      zone: routeContext.zoneEntry.zone,
      coverageType: inferredCoverageType,
      transportMode,
    } as const;
  }

  if (plan.pricingStrategy === "LEG_TRANSIT") {
    const transitLegs = normalizeTransitLegRates(plan.transitPricingConfig);
    if (transitLegs.length === 0) {
      return {
        quoteAvailable: false,
        reason: "transit_leg_config_missing",
        serviceType: input.serviceType,
        originRegion: {
          id: routeContext.originRegion!.id,
          code: routeContext.originRegion!.code,
          name: routeContext.originRegion!.name,
        },
        destinationRegion: {
          id: routeContext.destinationRegion!.id,
          code: routeContext.destinationRegion!.code,
          name: routeContext.destinationRegion!.name,
        },
        zone: routeContext.zoneEntry.zone,
        tariffPlan: {
          id: plan.id,
          name: plan.name,
          code: plan.code ?? null,
          routeTemplateId: plan.routeTemplateId ?? null,
        },
        coverageType: plan.coverageType,
        transportMode,
      } as const;
    }

    const legBreakdown = transitLegs.map((leg) => ({
      sequence: leg.sequence,
      legCode: leg.legCode,
      label: leg.label,
      mode: leg.mode,
      originCountryCode: leg.originCountryCode,
      destinationCountryCode: leg.destinationCountryCode,
      ratePerKg: leg.ratePerKg,
      minCharge: leg.minCharge,
      flatFee: leg.flatFee,
      charge: resolveTransitLegCharge(weightKg, leg),
    }));

    const serviceCharge = roundTo2(
      legBreakdown.reduce((sum, leg) => sum + leg.charge, 0),
    );
    if (serviceCharge <= 0) {
      return {
        quoteAvailable: false,
        reason: "transit_leg_config_invalid",
        serviceType: input.serviceType,
        originRegion: {
          id: routeContext.originRegion!.id,
          code: routeContext.originRegion!.code,
          name: routeContext.originRegion!.name,
        },
        destinationRegion: {
          id: routeContext.destinationRegion!.id,
          code: routeContext.destinationRegion!.code,
          name: routeContext.destinationRegion!.name,
        },
        zone: routeContext.zoneEntry.zone,
        tariffPlan: {
          id: plan.id,
          name: plan.name,
          code: plan.code ?? null,
          routeTemplateId: plan.routeTemplateId ?? null,
        },
        coverageType: plan.coverageType,
        transportMode,
      } as const;
    }

    return {
      quoteAvailable: true,
      reason: null,
      serviceType: input.serviceType,
      weightKg,
      currency: plan.currency,
      serviceCharge,
      originRegion: {
        id: routeContext.originRegion!.id,
        code: routeContext.originRegion!.code,
        name: routeContext.originRegion!.name,
      },
      destinationRegion: {
        id: routeContext.destinationRegion!.id,
        code: routeContext.destinationRegion!.code,
        name: routeContext.destinationRegion!.name,
      },
      zone: routeContext.zoneEntry.zone,
      coverageType: plan.coverageType,
      transportMode,
      tariffPlan: {
        id: plan.id,
        name: plan.name,
        code: plan.code ?? null,
        routeTemplateId: plan.routeTemplateId ?? null,
        priceType: plan.priceType,
        pricingStrategy: plan.pricingStrategy,
        priority: plan.priority,
        isDefault: plan.isDefault,
        customerEntityId: plan.customerEntityId ?? null,
      },
      legBreakdown,
      matchedRate: null,
    } as const;
  }

  const matchedRate =
    plan.rates.find((rate: any) => {
      const from = toNumber(rate.weightFromKg) ?? 0;
      const to = toNumber(rate.weightToKg);
      if (to == null) return false;
      return weightKg > from && weightKg <= to;
    }) ??
    plan.rates.find((rate: any) => {
      const from = toNumber(rate.weightFromKg) ?? 0;
      const to = toNumber(rate.weightToKg);
      if (to == null) return false;
      return weightKg >= from && weightKg <= to;
    }) ??
    null;

  if (!matchedRate) {
    return {
      quoteAvailable: false,
      reason: "rate_not_found",
      serviceType: input.serviceType,
      originRegion: {
        id: routeContext.originRegion!.id,
        code: routeContext.originRegion!.code,
        name: routeContext.originRegion!.name,
      },
      destinationRegion: {
        id: routeContext.destinationRegion!.id,
        code: routeContext.destinationRegion!.code,
        name: routeContext.destinationRegion!.name,
      },
      zone: routeContext.zoneEntry.zone,
      tariffPlan: {
        id: plan.id,
        name: plan.name,
        code: plan.code ?? null,
        routeTemplateId: plan.routeTemplateId ?? null,
      },
      coverageType: plan.coverageType,
      transportMode,
    } as const;
  }

  return {
    quoteAvailable: true,
    reason: null,
    serviceType: input.serviceType,
    weightKg,
    currency: plan.currency,
    serviceCharge: toNumber(matchedRate.price) ?? 0,
    originRegion: {
      id: routeContext.originRegion!.id,
      code: routeContext.originRegion!.code,
      name: routeContext.originRegion!.name,
    },
    destinationRegion: {
      id: routeContext.destinationRegion!.id,
      code: routeContext.destinationRegion!.code,
      name: routeContext.destinationRegion!.name,
    },
    zone: routeContext.zoneEntry.zone,
    coverageType: plan.coverageType,
    transportMode,
    tariffPlan: {
      id: plan.id,
      name: plan.name,
      code: plan.code ?? null,
      routeTemplateId: plan.routeTemplateId ?? null,
      priceType: plan.priceType,
      pricingStrategy: plan.pricingStrategy,
      priority: plan.priority,
      isDefault: plan.isDefault,
      customerEntityId: plan.customerEntityId ?? null,
    },
    matchedRate: {
      id: matchedRate.id,
      zone: matchedRate.zone,
      weightFromKg: toNumber(matchedRate.weightFromKg),
      weightToKg: toNumber(matchedRate.weightToKg),
      price: toNumber(matchedRate.price),
    },
  } as const;
}

export async function quoteTariffOptions(input: QuoteTariffOptionsInput) {
  const results = await Promise.all(
    TARIFF_TRANSPORT_MODES.map(async (transportMode) => {
      const quote = await quoteTariff({
        ...input,
        transportMode,
      });
      return {
        transportMode,
        ...quote,
      };
    }),
  );

  const available = results
    .filter((item) => item.quoteAvailable)
    .sort((left, right) => {
      const leftPrice = Number(left.serviceCharge ?? Number.POSITIVE_INFINITY);
      const rightPrice = Number(right.serviceCharge ?? Number.POSITIVE_INFINITY);
      if (leftPrice !== rightPrice) return leftPrice - rightPrice;
      return left.transportMode.localeCompare(right.transportMode);
    });

  return {
    availableModes: available.map((item) => item.transportMode),
    options: results,
    recommendedTransportMode: available[0]?.transportMode ?? null,
  } as const;
}
