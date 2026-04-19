import { PaidStatus, Prisma } from "@prisma/client";
import prisma from "../../config/prismaClient";

const db = prisma as any;

const ACTIVE_ORDER_STATUSES = [
  "pending",
  "assigned",
  "pickup_in_progress",
  "picked_up",
  "at_warehouse",
  "in_transit",
  "out_for_delivery",
  "exception",
  "return_in_progress",
] as const;

const DEFAULT_SLA_POLICY = {
  singletonKey: "global",
  staleHours: 48,
  dueSoonHours: 24,
  overdueGraceHours: 0,
} as const;
const UNPAID_PAID_STATUSES: PaidStatus[] = ["NOT_PAID", "PARTIAL"];

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function startOfUtcDay(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0),
  );
}

function endOfUtcDay(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999),
  );
}

function subtractDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() - days);
  return next;
}

function dayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function buildDailyBuckets(start: Date, end: Date) {
  const buckets: Array<{ date: string; count: number }> = [];
  const cursor = startOfUtcDay(start);
  const last = startOfUtcDay(end);

  while (cursor <= last) {
    buckets.push({ date: dayKey(cursor), count: 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return buckets;
}

function bucketByDay(
  rows: Array<{ day: Date; count: number }>,
  start: Date,
  end: Date,
) {
  const buckets = buildDailyBuckets(start, end);
  const index = new Map(buckets.map((bucket) => [bucket.date, bucket]));

  for (const row of rows) {
    const key = dayKey(startOfUtcDay(row.day));
    const bucket = index.get(key);
    if (bucket) bucket.count += row.count;
  }

  return buckets;
}

export async function getManagerAnalyticsSummary(params?: {
  rangeDays?: number;
  staleHours?: number;
  queueLimit?: number;
  queuePage?: number;
  queuePageSize?: number;
  queueFrom?: Date;
  queueTo?: Date;
  queueStatuses?: string[];
  queueKinds?: string[];
  queueHolderTypes?: string[];
}) {
  let policy: {
    staleHours: number;
    dueSoonHours: number;
    overdueGraceHours: number;
  } = {
    staleHours: DEFAULT_SLA_POLICY.staleHours,
    dueSoonHours: DEFAULT_SLA_POLICY.dueSoonHours,
    overdueGraceHours: DEFAULT_SLA_POLICY.overdueGraceHours,
  };

  try {
    if (typeof db?.operationalSlaPolicy?.upsert === "function") {
      const policyRow = await db.operationalSlaPolicy.upsert({
        where: { singletonKey: DEFAULT_SLA_POLICY.singletonKey },
        update: {},
        create: DEFAULT_SLA_POLICY,
      });

      policy = {
        staleHours: clampInt(
          policyRow?.staleHours,
          6,
          720,
          DEFAULT_SLA_POLICY.staleHours,
        ),
        dueSoonHours: clampInt(
          policyRow?.dueSoonHours,
          1,
          168,
          DEFAULT_SLA_POLICY.dueSoonHours,
        ),
        overdueGraceHours: clampInt(
          policyRow?.overdueGraceHours,
          0,
          168,
          DEFAULT_SLA_POLICY.overdueGraceHours,
        ),
      };
    }
  } catch (error: any) {
    const knownSchemaMismatch =
      error?.code === "P2021" ||
      error?.code === "P2022" ||
      /OperationalSlaPolicy/i.test(String(error?.message ?? ""));
    if (!knownSchemaMismatch) {
      throw error;
    }
  }

  const rangeDays = clampInt(params?.rangeDays ?? 30, 7, 180, 30);
  const staleHours = clampInt(
    params?.staleHours ?? policy.staleHours,
    6,
    720,
    policy.staleHours,
  );
  const queuePageSize = Math.min(
    Math.max(Number(params?.queuePageSize ?? params?.queueLimit ?? 20) || 20, 5),
    200,
  );
  const queuePage = Math.max(Number(params?.queuePage ?? 1) || 1, 1);
  const queueOffset = (queuePage - 1) * queuePageSize;

  const queueStatuses = Array.from(
    new Set((params?.queueStatuses ?? []).filter((v) => v === "expected" || v === "held")),
  );
  const queueKinds = Array.from(
    new Set(
      (params?.queueKinds ?? []).filter(
        (v) => v === "cod" || v === "service_charge",
      ),
    ),
  );
  const queueHolderTypes = Array.from(
    new Set(
      (params?.queueHolderTypes ?? []).filter((v) =>
        ["none", "driver", "warehouse", "pickup_point", "finance"].includes(v),
      ),
    ),
  );

  const now = new Date();
  const rangeStart = startOfUtcDay(subtractDays(now, rangeDays - 1));
  const rangeEnd = endOfUtcDay(now);
  const overdueBefore = new Date(
    now.getTime() - policy.overdueGraceHours * 60 * 60 * 1000,
  );
  const dueSoonEnd = new Date(now.getTime() + policy.dueSoonHours * 60 * 60 * 1000);
  const staleBefore = new Date(now.getTime() - staleHours * 60 * 60 * 1000);

  const createdTrendPromise = prisma.$queryRaw<Array<{ day: Date; count: bigint }>>(
    Prisma.sql`
      SELECT DATE_TRUNC('day', "createdAt") AS day, COUNT(*)::bigint AS count
      FROM "Order"
      WHERE "createdAt" >= ${rangeStart} AND "createdAt" <= ${rangeEnd}
      GROUP BY DATE_TRUNC('day', "createdAt")
      ORDER BY day ASC
    `,
  );

  const deliveredTrendPromise = prisma.$queryRaw<Array<{ day: Date; count: bigint }>>(
    Prisma.sql`
      SELECT DATE_TRUNC('day', "updatedAt") AS day, COUNT(*)::bigint AS count
      FROM "Order"
      WHERE "status" = 'delivered'
        AND "updatedAt" >= ${rangeStart}
        AND "updatedAt" <= ${rangeEnd}
      GROUP BY DATE_TRUNC('day', "updatedAt")
      ORDER BY day ASC
    `,
  );

  const overdueWarningOrdersPromise = prisma.order.findMany({
    where: {
      status: { in: [...ACTIVE_ORDER_STATUSES] },
      expectedDeliveryAt: { lt: overdueBefore },
    },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      expectedDeliveryAt: true,
      updatedAt: true,
    },
    orderBy: [{ expectedDeliveryAt: "asc" }, { updatedAt: "asc" }],
    take: 20,
  });

  const staleWarningOrdersPromise = prisma.order.findMany({
    where: {
      status: { in: [...ACTIVE_ORDER_STATUSES] },
      updatedAt: { lt: staleBefore },
    },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      expectedDeliveryAt: true,
      updatedAt: true,
    },
    orderBy: [{ updatedAt: "asc" }],
    take: 20,
  });

  const financeExposureWhere = {
    createdAt: { gte: rangeStart, lte: rangeEnd },
    OR: [
      {
        serviceCharge: { gt: 0 },
        serviceChargePaidStatus: { in: UNPAID_PAID_STATUSES },
      },
      {
        codAmount: { gt: 0 },
        codPaidStatus: { in: UNPAID_PAID_STATUSES },
      },
    ],
  };

  const financeExposureOrdersTotalPromise = prisma.order.count({
    where: financeExposureWhere,
  });

  const financeExposureWarningOrdersPromise = prisma.order.findMany({
    where: financeExposureWhere,
    select: {
      id: true,
      orderNumber: true,
      status: true,
      codAmount: true,
      codPaidStatus: true,
      serviceCharge: true,
      serviceChargePaidStatus: true,
      updatedAt: true,
    },
    orderBy: [{ updatedAt: "desc" }],
    take: 20,
  });

  const driverHeldWarningOrdersPromise = prisma.$queryRaw<
    Array<{
      orderId: string;
      orderNumber: string | null;
      orderStatus: string;
      amount: number | null;
      currency: string | null;
    }>
  >(
    Prisma.sql`
      SELECT
        o.id AS "orderId",
        o."orderNumber",
        o.status::text AS "orderStatus",
        COALESCE(SUM(COALESCE(cc."collectedAmount", cc."expectedAmount")), 0)::double precision AS amount,
        MAX(cc.currency) AS currency
      FROM "CashCollection" cc
      INNER JOIN "Order" o ON o.id = cc."orderId"
      WHERE cc.status = 'held'
        AND cc."currentHolderType" = 'driver'
      GROUP BY o.id, o."orderNumber", o.status
      ORDER BY amount DESC
      LIMIT 20
    `,
  );

  const cashCustodySnapshotPromise = prisma.$queryRaw<
    Array<{
      uncollectedExpectedAmount: number | null;
      driverHeldAmount: number | null;
      warehouseHeldAmount: number | null;
      pickupPointHeldAmount: number | null;
      settledAmount: number | null;
    }>
  >(
    Prisma.sql`
      SELECT
        COALESCE(SUM(CASE
          WHEN status = 'expected' THEN "expectedAmount"
          ELSE 0
        END), 0)::double precision AS "uncollectedExpectedAmount",
        COALESCE(SUM(CASE
          WHEN status = 'held' AND "currentHolderType" = 'driver' THEN COALESCE("collectedAmount", "expectedAmount")
          ELSE 0
        END), 0)::double precision AS "driverHeldAmount",
        COALESCE(SUM(CASE
          WHEN status = 'held' AND "currentHolderType" = 'warehouse' THEN COALESCE("collectedAmount", "expectedAmount")
          ELSE 0
        END), 0)::double precision AS "warehouseHeldAmount",
        COALESCE(SUM(CASE
          WHEN status = 'held' AND "currentHolderType" = 'pickup_point' THEN COALESCE("collectedAmount", "expectedAmount")
          ELSE 0
        END), 0)::double precision AS "pickupPointHeldAmount",
        COALESCE(SUM(CASE
          WHEN status = 'settled' THEN COALESCE("collectedAmount", "expectedAmount")
          ELSE 0
        END), 0)::double precision AS "settledAmount"
      FROM "CashCollection"
    `,
  );

  const cashHolderBreakdownPromise = prisma.$queryRaw<
    Array<{
      holderType: string | null;
      holderId: string | null;
      holderLabel: string | null;
      collectionCount: bigint;
      totalAmount: number | null;
    }>
  >(
    Prisma.sql`
      SELECT
        cc."currentHolderType"::text AS "holderType",
        COALESCE(cc."currentHolderUserId"::text, cc."currentHolderWarehouseId"::text) AS "holderId",
        COALESCE(cc."currentHolderLabel", u."name", w."name") AS "holderLabel",
        COUNT(*)::bigint AS "collectionCount",
        COALESCE(SUM(COALESCE(cc."collectedAmount", cc."expectedAmount")), 0)::double precision AS "totalAmount"
      FROM "CashCollection" cc
      LEFT JOIN "User" u ON u.id = cc."currentHolderUserId"
      LEFT JOIN "Warehouse" w ON w.id = cc."currentHolderWarehouseId"
      WHERE cc.status = 'held'
      GROUP BY
        cc."currentHolderType",
        COALESCE(cc."currentHolderUserId"::text, cc."currentHolderWarehouseId"::text),
        COALESCE(cc."currentHolderLabel", u."name", w."name")
      ORDER BY "totalAmount" DESC, "collectionCount" DESC
      LIMIT 8
    `,
  );

  const queueWhereParts: Prisma.Sql[] = [
    Prisma.sql`cc.status IN ('expected', 'held')`,
  ];
  const queueReferenceAtSql = Prisma.sql`COALESCE(cc."collectedAt", cc."createdAt", cc."updatedAt")`;

  if (queueStatuses.length) {
    queueWhereParts.push(
      Prisma.sql`cc.status::text IN (${Prisma.join(queueStatuses)})`,
    );
  }

  if (queueKinds.length) {
    queueWhereParts.push(Prisma.sql`cc.kind::text IN (${Prisma.join(queueKinds)})`);
  }

  if (queueHolderTypes.length) {
    queueWhereParts.push(
      Prisma.sql`cc."currentHolderType"::text IN (${Prisma.join(queueHolderTypes)})`,
    );
  }

  if (params?.queueFrom) {
    queueWhereParts.push(Prisma.sql`${queueReferenceAtSql} >= ${params.queueFrom}`);
  }

  if (params?.queueTo) {
    queueWhereParts.push(Prisma.sql`${queueReferenceAtSql} < ${params.queueTo}`);
  }

  const cashOpenQueueTotalPromise = prisma.$queryRaw<Array<{ total: bigint }>>(
    Prisma.sql`
      SELECT COUNT(*)::bigint AS total
      FROM "CashCollection" cc
      INNER JOIN "Order" o ON o.id = cc."orderId"
      WHERE ${Prisma.join(queueWhereParts, " AND ")}
    `,
  );

  const cashOpenQueuePromise = prisma.$queryRaw<
    Array<{
      id: string;
      orderId: string;
      orderNumber: string | null;
      orderStatus: string;
      kind: string;
      status: string;
      holderType: string | null;
      holderLabel: string | null;
      amount: number | null;
      currency: string | null;
      referenceAt: Date | null;
      updatedAt: Date;
    }>
  >(
    Prisma.sql`
      SELECT
        cc.id,
        cc."orderId",
        o."orderNumber",
        o.status::text AS "orderStatus",
        cc.kind::text AS kind,
        cc.status::text AS status,
        cc."currentHolderType"::text AS "holderType",
        COALESCE(cc."currentHolderLabel", u."name", w."name") AS "holderLabel",
        COALESCE(cc."collectedAmount", cc."expectedAmount")::double precision AS amount,
        cc.currency,
        COALESCE(cc."collectedAt", cc."createdAt", cc."updatedAt") AS "referenceAt",
        cc."updatedAt"
      FROM "CashCollection" cc
      INNER JOIN "Order" o ON o.id = cc."orderId"
      LEFT JOIN "User" u ON u.id = cc."currentHolderUserId"
      LEFT JOIN "Warehouse" w ON w.id = cc."currentHolderWarehouseId"
      WHERE ${Prisma.join(queueWhereParts, " AND ")}
      ORDER BY
        ${queueReferenceAtSql} DESC,
        cc."updatedAt" DESC
      LIMIT ${queuePageSize}
      OFFSET ${queueOffset}
    `,
  );

  const [
    totalOrders,
    createdInRange,
    openOrders,
    overdueOpenOrders,
    dueTodayOpenOrders,
    staleOpenOrders,
    promiseBackedOrders,
    ruleBackedOrders,
    fallbackBackedOrders,
    untrackedOpenOrders,
    pendingOrders,
    atWarehouseOrders,
    inTransitOrders,
    outForDeliveryOrders,
    exceptionOpenOrders,
    warehouseAtWarehouseOrders,
    pickupPointAtWarehouseOrders,
    warehouseOutForDeliveryOrders,
    pickupPointOutForDeliveryOrders,
    warehouseActiveOrders,
    pickupPointActiveOrders,
    deliveredInRange,
    warehouseDeliveredInRange,
    pickupPointDeliveredInRange,
    returnedInRange,
    financeExposureOrdersTotal,
    serviceChargeExpected,
    codExpected,
    unpaidServiceCount,
    unpaidCodCount,
    paidInvoices,
    pendingInvoicesCount,
    statusDistribution,
    serviceTypeDistribution,
    createdTrendRows,
    deliveredTrendRows,
    overdueWarningOrders,
    staleWarningOrders,
    financeExposureWarningOrders,
    driverHeldWarningOrders,
    cashCustodySnapshotRows,
    cashHolderBreakdownRows,
    cashOpenQueueTotalRows,
    cashOpenQueueRows,
  ] = await Promise.all([
    prisma.order.count(),
    prisma.order.count({
      where: { createdAt: { gte: rangeStart, lte: rangeEnd } },
    }),
    prisma.order.count({
      where: { status: { in: [...ACTIVE_ORDER_STATUSES] } },
    }),
    prisma.order.count({
      where: {
        status: { in: [...ACTIVE_ORDER_STATUSES] },
        expectedDeliveryAt: { lt: overdueBefore },
      },
    }),
    prisma.order.count({
      where: {
        status: { in: [...ACTIVE_ORDER_STATUSES] },
        expectedDeliveryAt: { gte: now, lte: dueSoonEnd },
      },
    }),
    prisma.order.count({
      where: {
        status: { in: [...ACTIVE_ORDER_STATUSES] },
        updatedAt: { lt: staleBefore },
      },
    }),
    prisma.order.count({
      where: { slaSource: "PROMISE_DATE" },
    }),
    prisma.order.count({
      where: { slaSource: "SLA_RULE", slaRuleId: { not: null } },
    }),
    prisma.order.count({
      where: {
        slaSource: "SLA_RULE",
        slaRule: {
          is: {
            zone: null,
            originRegionId: null,
            destinationRegionId: null,
          },
        },
      },
    }),
    prisma.order.count({
      where: {
        status: { in: [...ACTIVE_ORDER_STATUSES] },
        expectedDeliveryAt: null,
      },
    }),
    prisma.order.count({ where: { status: "pending" } }),
    prisma.order.count({ where: { status: "at_warehouse" } }),
    prisma.order.count({ where: { status: "in_transit" } }),
    prisma.order.count({ where: { status: "out_for_delivery" } }),
    prisma.order.count({
      where: { status: { in: ["exception", "return_in_progress"] } },
    }),
    prisma.order.count({
      where: {
        status: "at_warehouse",
        currentWarehouse: { type: "warehouse" },
      },
    }),
    prisma.order.count({
      where: {
        status: "at_warehouse",
        currentWarehouse: { type: "pickup_point" },
      },
    }),
    prisma.order.count({
      where: {
        status: "out_for_delivery",
        currentWarehouse: { type: "warehouse" },
      },
    }),
    prisma.order.count({
      where: {
        status: "out_for_delivery",
        currentWarehouse: { type: "pickup_point" },
      },
    }),
    prisma.order.count({
      where: {
        status: { in: [...ACTIVE_ORDER_STATUSES] },
        currentWarehouse: { type: "warehouse" },
      },
    }),
    prisma.order.count({
      where: {
        status: { in: [...ACTIVE_ORDER_STATUSES] },
        currentWarehouse: { type: "pickup_point" },
      },
    }),
    prisma.order.count({
      where: {
        status: "delivered",
        updatedAt: { gte: rangeStart, lte: rangeEnd },
      },
    }),
    prisma.order.count({
      where: {
        status: "delivered",
        updatedAt: { gte: rangeStart, lte: rangeEnd },
        currentWarehouse: { type: "warehouse" },
      },
    }),
    prisma.order.count({
      where: {
        status: "delivered",
        updatedAt: { gte: rangeStart, lte: rangeEnd },
        currentWarehouse: { type: "pickup_point" },
      },
    }),
    prisma.order.count({
      where: {
        status: "returned",
        updatedAt: { gte: rangeStart, lte: rangeEnd },
      },
    }),
    financeExposureOrdersTotalPromise,
    prisma.order.aggregate({
      _sum: { serviceCharge: true },
      where: {
        createdAt: { gte: rangeStart, lte: rangeEnd },
        serviceCharge: { not: null },
      },
    }),
    prisma.order.aggregate({
      _sum: { codAmount: true },
      where: {
        createdAt: { gte: rangeStart, lte: rangeEnd },
        codAmount: { not: null },
      },
    }),
    prisma.order.count({
      where: {
        createdAt: { gte: rangeStart, lte: rangeEnd },
        serviceCharge: { gt: 0 },
        serviceChargePaidStatus: { in: ["NOT_PAID", "PARTIAL"] },
      },
    }),
    prisma.order.count({
      where: {
        createdAt: { gte: rangeStart, lte: rangeEnd },
        codAmount: { gt: 0 },
        codPaidStatus: { in: ["NOT_PAID", "PARTIAL"] },
      },
    }),
    prisma.invoice.aggregate({
      _sum: { amount: true },
      where: {
        status: "paid",
        createdAt: { gte: rangeStart, lte: rangeEnd },
      },
    }),
    prisma.invoice.count({
      where: {
        status: "pending",
        createdAt: { gte: rangeStart, lte: rangeEnd },
      },
    }),
    prisma.order.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
    prisma.order.groupBy({
      by: ["serviceType"],
      _count: { _all: true },
      where: {
        createdAt: { gte: rangeStart, lte: rangeEnd },
        serviceType: { not: null },
      },
    }),
    createdTrendPromise,
    deliveredTrendPromise,
    overdueWarningOrdersPromise,
    staleWarningOrdersPromise,
    financeExposureWarningOrdersPromise,
    driverHeldWarningOrdersPromise,
    cashCustodySnapshotPromise,
    cashHolderBreakdownPromise,
    cashOpenQueueTotalPromise,
    cashOpenQueuePromise,
  ]);

  const cashCustodySnapshot = cashCustodySnapshotRows[0] ?? {
    uncollectedExpectedAmount: 0,
    driverHeldAmount: 0,
    warehouseHeldAmount: 0,
    pickupPointHeldAmount: 0,
    settledAmount: 0,
  };

  return {
    period: {
      rangeDays,
      staleHours,
      from: rangeStart.toISOString(),
      to: rangeEnd.toISOString(),
    },
    overview: {
      totalOrders,
      createdInRange,
      openOrders,
      deliveredInRange,
      returnedInRange,
      exceptionOpenOrders,
    },
    operations: {
      pendingOrders,
      atWarehouseOrders,
      inTransitOrders,
      outForDeliveryOrders,
      staleOpenOrders,
      locationThroughput: {
        warehouse: {
          activeOrders: warehouseActiveOrders,
          atWarehouseOrders: warehouseAtWarehouseOrders,
          outForDeliveryOrders: warehouseOutForDeliveryOrders,
          deliveredInRange: warehouseDeliveredInRange,
        },
        pickupPoint: {
          activeOrders: pickupPointActiveOrders,
          atWarehouseOrders: pickupPointAtWarehouseOrders,
          outForDeliveryOrders: pickupPointOutForDeliveryOrders,
          deliveredInRange: pickupPointDeliveredInRange,
        },
      },
    },
    sla: {
      overdueOpenOrders,
      dueTodayOpenOrders,
      dueSoonOpenOrders: dueTodayOpenOrders,
      promiseBackedOrders,
      ruleBackedOrders,
      fallbackBackedOrders,
      trackedOpenOrders: Math.max(openOrders - untrackedOpenOrders, 0),
      untrackedOpenOrders,
    },
    slaPolicy: {
      staleHours: policy.staleHours,
      dueSoonHours: policy.dueSoonHours,
      overdueGraceHours: policy.overdueGraceHours,
      staleHoursApplied: staleHours,
    },
    finance: {
      invoicedPaidAmount: paidInvoices._sum.amount ?? 0,
      pendingInvoicesCount,
      serviceChargeExpected: serviceChargeExpected._sum.serviceCharge ?? 0,
      codExpected: codExpected._sum.codAmount ?? 0,
      unpaidServiceCount,
      unpaidCodCount,
      uncollectedExpectedAmount: cashCustodySnapshot.uncollectedExpectedAmount ?? 0,
      driverHeldAmount: cashCustodySnapshot.driverHeldAmount ?? 0,
      warehouseHeldAmount: cashCustodySnapshot.warehouseHeldAmount ?? 0,
      pickupPointHeldAmount: cashCustodySnapshot.pickupPointHeldAmount ?? 0,
      settledAmount: cashCustodySnapshot.settledAmount ?? 0,
      holders: cashHolderBreakdownRows.map((row) => ({
        holderType: row.holderType ?? "none",
        holderId: row.holderId ?? null,
        holderLabel: row.holderLabel ?? "Unknown holder",
        collectionCount: Number(row.collectionCount),
        totalAmount: row.totalAmount ?? 0,
      })),
      queue: cashOpenQueueRows.map((row) => {
        const referenceAt = row.referenceAt ?? row.updatedAt;
        const ageHours = Math.max(
          0,
          Math.round((now.getTime() - new Date(referenceAt).getTime()) / (1000 * 60 * 60)),
        );

        return {
          id: row.id,
          orderId: row.orderId,
          orderNumber: row.orderNumber,
          orderStatus: row.orderStatus,
          kind: row.kind,
          status: row.status,
          holderType: row.holderType ?? "none",
          holderLabel: row.holderLabel ?? null,
          amount: row.amount ?? 0,
          currency: row.currency ?? null,
          ageHours,
          updatedAt: row.updatedAt.toISOString(),
        };
      }),
      queueMeta: (() => {
        const total = Number(cashOpenQueueTotalRows[0]?.total ?? 0);
        const pageCount = Math.max(1, Math.ceil(total / queuePageSize));
        return {
          page: Math.min(queuePage, pageCount),
          pageSize: queuePageSize,
          total,
          pageCount,
          hasPrev: queuePage > 1,
          hasNext: queuePage < pageCount,
        };
      })(),
    },
    breakdowns: {
      status: statusDistribution.map((row) => ({
        status: row.status,
        count: row._count._all,
      })),
      serviceType: serviceTypeDistribution
        .filter((row) => row.serviceType)
        .map((row) => ({
          serviceType: row.serviceType,
          count: row._count._all,
        })),
    },
    warnings: {
      overdueTotal: overdueOpenOrders,
      staleTotal: staleOpenOrders,
      financeExposureTotal: financeExposureOrdersTotal,
      overdueOrders: overdueWarningOrders.map((order) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        status: String(order.status),
        expectedDeliveryAt: order.expectedDeliveryAt
          ? order.expectedDeliveryAt.toISOString()
          : null,
        updatedAt: order.updatedAt.toISOString(),
      })),
      staleOrders: staleWarningOrders.map((order) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        status: String(order.status),
        expectedDeliveryAt: order.expectedDeliveryAt
          ? order.expectedDeliveryAt.toISOString()
          : null,
        updatedAt: order.updatedAt.toISOString(),
      })),
      financeExposureOrders: financeExposureWarningOrders.map((order) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        status: String(order.status),
        codDue:
          order.codAmount && ["NOT_PAID", "PARTIAL"].includes(String(order.codPaidStatus))
            ? order.codAmount
            : 0,
        serviceChargeDue:
          order.serviceCharge &&
          ["NOT_PAID", "PARTIAL"].includes(String(order.serviceChargePaidStatus))
            ? order.serviceCharge
            : 0,
        updatedAt: order.updatedAt.toISOString(),
      })),
      driverHeldOrders: driverHeldWarningOrders.map((row) => ({
        orderId: row.orderId,
        orderNumber: row.orderNumber,
        status: row.orderStatus,
        amount: row.amount ?? 0,
        currency: row.currency ?? null,
      })),
    },
    trend: {
      created: bucketByDay(
        createdTrendRows.map((row) => ({
          day: row.day,
          count: Number(row.count),
        })),
        rangeStart,
        rangeEnd,
      ),
      delivered: bucketByDay(
        deliveredTrendRows.map((row) => ({
          day: row.day,
          count: Number(row.count),
        })),
        rangeStart,
        rangeEnd,
      ),
    },
  };
}
