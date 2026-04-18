import prisma from "../../config/prismaClient";
import { OrderSlaSource, ServiceType } from "@prisma/client";
import { orderError } from "../orders/orderService.shared";
import {
  CreateDeliverySlaRuleInput,
  CreatePricingRegionInput,
  CreateTariffPlanInput,
  QuoteTariffInput,
  UpdateOperationalSlaPolicyInput,
  UpdateDeliverySlaRuleInput,
  UpdatePricingRegionInput,
  UpdateTariffPlanInput,
  UpsertZoneMatrixInput,
  normalizeTariffCode,
} from "./pricing.shared";

const db = prisma as any;
const OPERATIONAL_SLA_POLICY_KEY = "global";

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

type TariffPlanForQuote = {
  id: string;
  name: string;
  code?: string | null;
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

export async function listDeliverySlaRules(params: {
  q?: string;
  serviceType?: string;
  isActive?: boolean;
}) {
  const q = params.q?.trim();

  return db.deliverySlaRule.findMany({
    where: {
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
    },
    include: {
      originRegion: true,
      destinationRegion: true,
    },
    orderBy: [
      { serviceType: "asc" },
      { priority: "desc" },
      { createdAt: "desc" },
    ],
  });
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
}) {
  const q = params.q?.trim();

  return db.pricingRegion.findMany({
    where: {
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
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
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
  if (input.customerEntityId) {
    const customerEntity = await db.customerEntity.findUnique({
      where: { id: input.customerEntityId },
      select: { id: true },
    });

    if (!customerEntity) {
      throw orderError("customerEntityId not found", 400);
    }
  }

  return db.$transaction(async (tx: any) => {
    if (input.isDefault) {
      await tx.tariffPlan.updateMany({
        where: {
          serviceType: input.serviceType,
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
        rates: {
          orderBy: [{ zone: "asc" }, { weightFromKg: "asc" }],
        },
      },
    });
  });
}

export async function updateTariffPlan(id: string, input: UpdateTariffPlanInput) {
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

  return db.$transaction(async (tx: any) => {
    if (input.isDefault) {
      await tx.tariffPlan.updateMany({
        where: {
          id: { not: id },
          serviceType: input.serviceType,
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
        rates: {
          orderBy: [{ zone: "asc" }, { weightFromKg: "asc" }],
        },
      },
    });
  });
}

export async function listTariffPlans(params: {
  status?: "draft" | "active" | "archived";
  serviceType?: string;
  customerEntityId?: string;
  q?: string;
}) {
  const q = params.q?.trim();

  return db.tariffPlan.findMany({
    where: {
      ...(params.status ? { status: params.status } : {}),
      ...(params.serviceType ? { serviceType: params.serviceType } : {}),
      ...(params.customerEntityId
        ? { customerEntityId: params.customerEntityId }
        : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { code: { contains: q, mode: "insensitive" } },
              { description: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    include: {
      customerEntity: {
        select: { id: true, name: true, type: true },
      },
      _count: {
        select: { rates: true },
      },
    },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
  });
}

export async function getTariffPlanById(id: string) {
  return db.tariffPlan.findUnique({
    where: { id },
    include: {
      customerEntity: {
        select: { id: true, name: true, type: true },
      },
      rates: {
        orderBy: [{ zone: "asc" }, { weightFromKg: "asc" }],
      },
    },
  });
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

  if (routeContext.reason || !routeContext.zoneEntry) {
    return {
      expectedDeliveryAt: null,
      slaSource: OrderSlaSource.NONE,
      slaRuleId: null,
      slaTargetDays: null,
    } as const;
  }

  const rules = await db.deliverySlaRule.findMany({
    where: {
      isActive: true,
      serviceType: input.serviceType as ServiceType,
      OR: [
        {
          originRegionId: routeContext.originRegion?.id ?? undefined,
          destinationRegionId: routeContext.destinationRegion?.id ?? undefined,
        },
        {
          zone: routeContext.zoneEntry.zone,
          originRegionId: null,
          destinationRegionId: null,
        },
        {
          zone: null,
          originRegionId: null,
          destinationRegionId: null,
        },
      ],
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

export async function quoteTariff(input: QuoteTariffInput) {
  const weightKg = toNumber(input.weightKg);
  const originQuery = input.originQuery?.trim() ?? "";
  const destinationQuery = input.destinationQuery?.trim() ?? "";

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
      OR: input.customerEntityId
        ? [{ customerEntityId: input.customerEntityId }, { customerEntityId: null }]
        : [{ customerEntityId: null }],
    },
    include: {
      rates: {
        where: { zone: routeContext.zoneEntry.zone },
        orderBy: [{ weightFromKg: "asc" }, { weightToKg: "asc" }],
      },
    },
  });

  const plan = sortTariffPlans(plans, input.customerEntityId)[0] ?? null;
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
      },
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
    tariffPlan: {
      id: plan.id,
      name: plan.name,
      code: plan.code ?? null,
      priceType: plan.priceType,
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
