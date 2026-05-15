import { OrderSlaSource, ServiceType } from "@prisma/client";
import prisma from "../../../config/prismaClient";

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

const db = prisma as any;

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

  const candidates = [region.code, region.name, ...(Array.isArray(region.aliases) ? region.aliases : [])]
    .map((value) => normalizeRegionQuery(value))
    .filter(Boolean);

  return candidates.includes(normalizedQuery);
}

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
    };
  }

  const regions = await loadActivePricingRegions();
  const originRegion = regions.find((region: PricingRegionLite) => matchesRegion(region, originQuery)) ?? null;
  const destinationRegion =
    regions.find((region: PricingRegionLite) => matchesRegion(region, destinationQuery)) ?? null;

  if (!originRegion || !destinationRegion) {
    return {
      originRegion,
      destinationRegion,
      zoneEntry: null,
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

  return {
    originRegion,
    destinationRegion,
    zoneEntry: zoneEntry ?? null,
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

export async function resolveOrderSlaSnapshot(input: {
  serviceType?: ServiceType | string | null;
  originQuery?: string | null;
  destinationQuery?: string | null;
  promiseDate?: Date | string | null;
  createdAt?: Date;
}) {
  const createdAt = input.createdAt ?? new Date();
  const promiseDate = toDateOrNull(input.promiseDate);

  if (promiseDate) {
    return {
      expectedDeliveryAt: promiseDate,
      slaSource: OrderSlaSource.PROMISE_DATE,
      slaRuleId: null,
      slaTargetDays: null,
    } as const;
  }

  if (!input.serviceType) {
    return {
      expectedDeliveryAt: null,
      slaSource: OrderSlaSource.NONE,
      slaRuleId: null,
      slaTargetDays: null,
    } as const;
  }

  const routeContext = await resolvePricingRouteContext({
    originQuery: input.originQuery,
    destinationQuery: input.destinationQuery,
  });

  const ruleOrClauses: Array<any> = [
    {
      zone: null,
      originRegionId: null,
      destinationRegionId: null,
    },
  ];

  if (routeContext.originRegion?.id && routeContext.destinationRegion?.id) {
    ruleOrClauses.push({
      originRegionId: routeContext.originRegion.id,
      destinationRegionId: routeContext.destinationRegion.id,
    });
  }

  if (routeContext.zoneEntry?.zone !== undefined) {
    ruleOrClauses.push({
      zone: routeContext.zoneEntry.zone,
      originRegionId: null,
      destinationRegionId: null,
    });
  }

  const rules = await db.deliverySlaRule.findMany({
    where: {
      isActive: true,
      serviceType: input.serviceType as ServiceType,
      OR: ruleOrClauses,
    },
    select: {
      id: true,
      originRegionId: true,
      destinationRegionId: true,
      zone: true,
      priority: true,
      createdAt: true,
      deliveryDays: true,
    },
  });

  const matchedRule = pickBestDeliverySlaRule(rules, routeContext);
  if (!matchedRule) {
    return {
      expectedDeliveryAt: null,
      slaSource: OrderSlaSource.NONE,
      slaRuleId: null,
      slaTargetDays: null,
    } as const;
  }

  return {
    expectedDeliveryAt: addDaysUtc(createdAt, matchedRule.deliveryDays),
    slaSource: OrderSlaSource.SLA_RULE,
    slaRuleId: matchedRule.id,
    slaTargetDays: matchedRule.deliveryDays,
  } as const;
}
