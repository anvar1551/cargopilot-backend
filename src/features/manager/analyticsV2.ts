import { PaidStatus, Prisma } from "@prisma/client";
import prisma from "../../config/prismaClient";
import { getOrComputeCached, makeScopeKey } from "./analyticsV2Cache";

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
  staleHours: 48,
  dueSoonHours: 24,
  overdueGraceHours: 0,
} as const;

const UNPAID_PAID_STATUSES: PaidStatus[] = ["NOT_PAID", "PARTIAL"];

type Scope = {
  role: string;
  warehouseId: string | null;
  userId: string | null;
};

type SummaryParams = {
  rangeDays?: number;
  staleHours?: number;
  scope: Scope;
};

type TrendParams = {
  rangeDays?: number;
  scope: Scope;
};

type WarningsParams = {
  rangeDays?: number;
  staleHours?: number;
  scope: Scope;
};

type QueueParams = {
  queuePage?: number;
  queuePageSize?: number;
  queueFrom?: Date;
  queueTo?: Date;
  queueStatuses?: string[];
  queueKinds?: string[];
  queueHolderTypes?: string[];
  scope: Scope;
};

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

let cachedPolicy: {
  staleHours: number;
  dueSoonHours: number;
  overdueGraceHours: number;
  expiresAt: number;
} = {
  ...DEFAULT_SLA_POLICY,
  expiresAt: 0,
};

async function getSlaPolicy() {
  if (Date.now() < cachedPolicy.expiresAt) {
    return {
      staleHours: cachedPolicy.staleHours,
      dueSoonHours: cachedPolicy.dueSoonHours,
      overdueGraceHours: cachedPolicy.overdueGraceHours,
    };
  }

  try {
    const db = prisma as any;
    if (typeof db?.operationalSlaPolicy?.findUnique === "function") {
      const row = await db.operationalSlaPolicy.findUnique({
        where: { singletonKey: "global" },
      });
      if (row) {
        cachedPolicy = {
          staleHours: clampInt(row.staleHours, 6, 720, DEFAULT_SLA_POLICY.staleHours),
          dueSoonHours: clampInt(row.dueSoonHours, 1, 168, DEFAULT_SLA_POLICY.dueSoonHours),
          overdueGraceHours: clampInt(
            row.overdueGraceHours,
            0,
            168,
            DEFAULT_SLA_POLICY.overdueGraceHours,
          ),
          expiresAt: Date.now() + 5 * 60_000,
        };
        return {
          staleHours: cachedPolicy.staleHours,
          dueSoonHours: cachedPolicy.dueSoonHours,
          overdueGraceHours: cachedPolicy.overdueGraceHours,
        };
      }
    }
  } catch (error: any) {
    const knownSchemaMismatch =
      error?.code === "P2021" ||
      error?.code === "P2022" ||
      /OperationalSlaPolicy/i.test(String(error?.message ?? ""));
    if (!knownSchemaMismatch) {
      console.error(`[analytics-v2] sla policy load failed: ${error?.message || "unknown"}`);
    }
  }

  cachedPolicy = {
    staleHours: DEFAULT_SLA_POLICY.staleHours,
    dueSoonHours: DEFAULT_SLA_POLICY.dueSoonHours,
    overdueGraceHours: DEFAULT_SLA_POLICY.overdueGraceHours,
    expiresAt: Date.now() + 5 * 60_000,
  };
  return {
    staleHours: cachedPolicy.staleHours,
    dueSoonHours: cachedPolicy.dueSoonHours,
    overdueGraceHours: cachedPolicy.overdueGraceHours,
  };
}

function buildScopeOrderWhere(scope: Scope): Prisma.OrderWhereInput {
  if (scope.role !== "warehouse" || !scope.warehouseId) return {};
  return {
    OR: [
      { currentWarehouseId: scope.warehouseId },
      { assignedDriver: { warehouseId: scope.warehouseId } },
      { assignedDriver: { warehouseAccesses: { some: { warehouseId: scope.warehouseId } } } },
    ],
  };
}

function buildScopeQueueWhere(scope: Scope): Prisma.Sql[] {
  if (scope.role !== "warehouse" || !scope.warehouseId) return [];
  return [
    Prisma.sql`(
      o."currentWarehouseId" = ${scope.warehouseId}::uuid
      OR u."warehouseId" = ${scope.warehouseId}::uuid
      OR dwa."warehouseId" = ${scope.warehouseId}::uuid
    )`,
  ];
}

export async function getAnalyticsSummaryV2(params: SummaryParams) {
  const policy = await getSlaPolicy();
  const rangeDays = clampInt(params.rangeDays ?? 30, 7, 180, 30);
  const staleHours = clampInt(params.staleHours ?? policy.staleHours, 6, 720, policy.staleHours);
  const scopeKey = makeScopeKey(params.scope);

  const key = JSON.stringify({ scopeKey, rangeDays, staleHours });
  return getOrComputeCached({
    namespace: "summary",
    key,
    ttlMs: Number(process.env.ANALYTICS_V2_SUMMARY_TTL_MS || 60_000),
    compute: async () => {
      const now = new Date();
      const rangeStart = startOfUtcDay(subtractDays(now, rangeDays - 1));
      const rangeEnd = endOfUtcDay(now);
      const dueSoonEnd = new Date(now.getTime() + policy.dueSoonHours * 60 * 60 * 1000);
      const overdueBefore = new Date(now.getTime() - policy.overdueGraceHours * 60 * 60 * 1000);
      const staleBefore = new Date(now.getTime() - staleHours * 60 * 60 * 1000);
      const scopeWhere = buildScopeOrderWhere(params.scope);

      const [statusDistribution, createdInRange, deliveredInRange, returnedInRange, pendingInvoicesCount, paidInvoices, codExpected, serviceChargeExpected, unpaidCodCount, unpaidServiceCount] = await Promise.all([
        prisma.order.groupBy({
          by: ["status"],
          _count: { _all: true },
          where: scopeWhere,
        }),
        prisma.order.count({ where: { ...scopeWhere, createdAt: { gte: rangeStart, lte: rangeEnd } } }),
        prisma.order.count({ where: { ...scopeWhere, status: "delivered", updatedAt: { gte: rangeStart, lte: rangeEnd } } }),
        prisma.order.count({ where: { ...scopeWhere, status: "returned", updatedAt: { gte: rangeStart, lte: rangeEnd } } }),
        prisma.invoice.count({ where: { status: "pending", createdAt: { gte: rangeStart, lte: rangeEnd }, order: scopeWhere } }),
        prisma.invoice.aggregate({ _sum: { amount: true }, where: { status: "paid", createdAt: { gte: rangeStart, lte: rangeEnd }, order: scopeWhere } }),
        prisma.order.aggregate({ _sum: { codAmount: true }, where: { ...scopeWhere, createdAt: { gte: rangeStart, lte: rangeEnd }, codAmount: { not: null } } }),
        prisma.order.aggregate({ _sum: { serviceCharge: true }, where: { ...scopeWhere, createdAt: { gte: rangeStart, lte: rangeEnd }, serviceCharge: { not: null } } }),
        prisma.order.count({ where: { ...scopeWhere, createdAt: { gte: rangeStart, lte: rangeEnd }, codAmount: { gt: 0 }, codPaidStatus: { in: UNPAID_PAID_STATUSES } } }),
        prisma.order.count({ where: { ...scopeWhere, createdAt: { gte: rangeStart, lte: rangeEnd }, serviceCharge: { gt: 0 }, serviceChargePaidStatus: { in: UNPAID_PAID_STATUSES } } }),
      ]);

      const statusMap = new Map(statusDistribution.map((row) => [row.status, row._count._all]));
      const totalOrders = Array.from(statusMap.values()).reduce((sum, value) => sum + value, 0);
      const openOrders = ACTIVE_ORDER_STATUSES.reduce((sum, status) => sum + (statusMap.get(status) ?? 0), 0);
      const pendingOrders = statusMap.get("pending") ?? 0;
      const atWarehouseOrders = statusMap.get("at_warehouse") ?? 0;
      const inTransitOrders = statusMap.get("in_transit") ?? 0;
      const outForDeliveryOrders = statusMap.get("out_for_delivery") ?? 0;
      const exceptionOpenOrders = (statusMap.get("exception") ?? 0) + (statusMap.get("return_in_progress") ?? 0);

      const [overdueOpenOrders, dueSoonOpenOrders, staleOpenOrders] = await Promise.all([
        prisma.order.count({ where: { ...scopeWhere, status: { in: [...ACTIVE_ORDER_STATUSES] }, expectedDeliveryAt: { lt: overdueBefore } } }),
        prisma.order.count({ where: { ...scopeWhere, status: { in: [...ACTIVE_ORDER_STATUSES] }, expectedDeliveryAt: { gte: now, lte: dueSoonEnd } } }),
        prisma.order.count({ where: { ...scopeWhere, status: { in: [...ACTIVE_ORDER_STATUSES] }, updatedAt: { lt: staleBefore } } }),
      ]);

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
        },
        sla: {
          overdueOpenOrders,
          dueSoonOpenOrders,
          dueTodayOpenOrders: dueSoonOpenOrders,
        },
        finance: {
          invoicedPaidAmount: paidInvoices._sum.amount ?? 0,
          pendingInvoicesCount,
          serviceChargeExpected: serviceChargeExpected._sum.serviceCharge ?? 0,
          codExpected: codExpected._sum.codAmount ?? 0,
          unpaidServiceCount,
          unpaidCodCount,
        },
        generatedAt: new Date().toISOString(),
      };
    },
  });
}

export async function getAnalyticsTrendV2(params: TrendParams) {
  const rangeDays = clampInt(params.rangeDays ?? 30, 7, 180, 30);
  const scopeKey = makeScopeKey(params.scope);
  const key = JSON.stringify({ scopeKey, rangeDays });

  return getOrComputeCached({
    namespace: "trend",
    key,
    ttlMs: Number(process.env.ANALYTICS_V2_TREND_TTL_MS || 60_000),
    compute: async () => {
      const now = new Date();
      const rangeStart = startOfUtcDay(subtractDays(now, rangeDays - 1));
      const rangeEnd = endOfUtcDay(now);
      const scopeWhere = buildScopeOrderWhere(params.scope);

      const scopeSql =
        params.scope.role === "warehouse" && params.scope.warehouseId
          ? Prisma.sql`
              AND (
                o."currentWarehouseId" = ${params.scope.warehouseId}::uuid
                OR u."warehouseId" = ${params.scope.warehouseId}::uuid
                OR dwa."warehouseId" = ${params.scope.warehouseId}::uuid
              )
            `
          : Prisma.empty;

      const [createdRows, deliveredRows] = await Promise.all([
        prisma.$queryRaw<Array<{ day: Date; count: bigint }>>(
          Prisma.sql`
            SELECT DATE_TRUNC('day', o."createdAt") AS day, COUNT(*)::bigint AS count
            FROM "Order" o
            LEFT JOIN "User" u ON u.id = o."assignedDriverId"
            LEFT JOIN "DriverWarehouseAccess" dwa ON dwa."driverId" = u.id
            WHERE o."createdAt" >= ${rangeStart} AND o."createdAt" <= ${rangeEnd}
            ${scopeSql}
            GROUP BY DATE_TRUNC('day', o."createdAt")
            ORDER BY day ASC
          `,
        ),
        prisma.$queryRaw<Array<{ day: Date; count: bigint }>>(
          Prisma.sql`
            SELECT DATE_TRUNC('day', o."updatedAt") AS day, COUNT(*)::bigint AS count
            FROM "Order" o
            LEFT JOIN "User" u ON u.id = o."assignedDriverId"
            LEFT JOIN "DriverWarehouseAccess" dwa ON dwa."driverId" = u.id
            WHERE o."status" = 'delivered'
              AND o."updatedAt" >= ${rangeStart}
              AND o."updatedAt" <= ${rangeEnd}
              ${scopeSql}
            GROUP BY DATE_TRUNC('day', o."updatedAt")
            ORDER BY day ASC
          `,
        ),
      ]);

      void scopeWhere;

      return {
        period: {
          rangeDays,
          from: rangeStart.toISOString(),
          to: rangeEnd.toISOString(),
        },
        trend: {
          created: bucketByDay(
            createdRows.map((row) => ({ day: row.day, count: Number(row.count) })),
            rangeStart,
            rangeEnd,
          ),
          delivered: bucketByDay(
            deliveredRows.map((row) => ({ day: row.day, count: Number(row.count) })),
            rangeStart,
            rangeEnd,
          ),
        },
        generatedAt: new Date().toISOString(),
      };
    },
  });
}

export async function getAnalyticsWarningsV2(params: WarningsParams) {
  const policy = await getSlaPolicy();
  const rangeDays = clampInt(params.rangeDays ?? 30, 7, 180, 30);
  const staleHours = clampInt(params.staleHours ?? policy.staleHours, 6, 720, policy.staleHours);
  const scopeKey = makeScopeKey(params.scope);
  const key = JSON.stringify({ scopeKey, rangeDays, staleHours });

  return getOrComputeCached({
    namespace: "warnings",
    key,
    ttlMs: Number(process.env.ANALYTICS_V2_WARNINGS_TTL_MS || 60_000),
    compute: async () => {
      const now = new Date();
      const rangeStart = startOfUtcDay(subtractDays(now, rangeDays - 1));
      const rangeEnd = endOfUtcDay(now);
      const overdueBefore = new Date(now.getTime() - policy.overdueGraceHours * 60 * 60 * 1000);
      const staleBefore = new Date(now.getTime() - staleHours * 60 * 60 * 1000);
      const scopeWhere = buildScopeOrderWhere(params.scope);

      const financeExposureWhere: Prisma.OrderWhereInput = {
        ...scopeWhere,
        createdAt: { gte: rangeStart, lte: rangeEnd },
        OR: [
          { serviceCharge: { gt: 0 }, serviceChargePaidStatus: { in: UNPAID_PAID_STATUSES } },
          { codAmount: { gt: 0 }, codPaidStatus: { in: UNPAID_PAID_STATUSES } },
        ],
      };

      const [overdueTotal, staleTotal, financeExposureTotal, overdueOrders, staleOrders, financeExposureOrders] = await Promise.all([
        prisma.order.count({ where: { ...scopeWhere, status: { in: [...ACTIVE_ORDER_STATUSES] }, expectedDeliveryAt: { lt: overdueBefore } } }),
        prisma.order.count({ where: { ...scopeWhere, status: { in: [...ACTIVE_ORDER_STATUSES] }, updatedAt: { lt: staleBefore } } }),
        prisma.order.count({ where: financeExposureWhere }),
        prisma.order.findMany({
          where: { ...scopeWhere, status: { in: [...ACTIVE_ORDER_STATUSES] }, expectedDeliveryAt: { lt: overdueBefore } },
          select: { id: true, orderNumber: true, status: true, expectedDeliveryAt: true, updatedAt: true },
          orderBy: [{ expectedDeliveryAt: "asc" }, { updatedAt: "asc" }],
          take: 20,
        }),
        prisma.order.findMany({
          where: { ...scopeWhere, status: { in: [...ACTIVE_ORDER_STATUSES] }, updatedAt: { lt: staleBefore } },
          select: { id: true, orderNumber: true, status: true, expectedDeliveryAt: true, updatedAt: true },
          orderBy: [{ updatedAt: "asc" }],
          take: 20,
        }),
        prisma.order.findMany({
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
        }),
      ]);

      return {
        overdueTotal,
        staleTotal,
        financeExposureTotal,
        overdueOrders: overdueOrders.map((order) => ({
          id: order.id,
          orderNumber: order.orderNumber,
          status: String(order.status),
          expectedDeliveryAt: order.expectedDeliveryAt?.toISOString() ?? null,
          updatedAt: order.updatedAt.toISOString(),
        })),
        staleOrders: staleOrders.map((order) => ({
          id: order.id,
          orderNumber: order.orderNumber,
          status: String(order.status),
          expectedDeliveryAt: order.expectedDeliveryAt?.toISOString() ?? null,
          updatedAt: order.updatedAt.toISOString(),
        })),
        financeExposureOrders: financeExposureOrders.map((order) => ({
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
      };
    },
  });
}

export async function getAnalyticsFinanceQueueV2(params: QueueParams) {
  const queuePageSize = Math.min(
    Math.max(Number(params.queuePageSize ?? 20) || 20, 5),
    200,
  );
  const queuePage = Math.max(Number(params.queuePage ?? 1) || 1, 1);
  const queueOffset = (queuePage - 1) * queuePageSize;
  const scopeKey = makeScopeKey(params.scope);

  const queueStatuses = Array.from(
    new Set((params.queueStatuses ?? []).filter((v) => v === "expected" || v === "held")),
  );
  const queueKinds = Array.from(
    new Set((params.queueKinds ?? []).filter((v) => v === "cod" || v === "service_charge")),
  );
  const queueHolderTypes = Array.from(
    new Set((params.queueHolderTypes ?? []).filter((v) =>
      ["none", "driver", "warehouse", "pickup_point", "finance"].includes(v),
    )),
  );

  const key = JSON.stringify({
    scopeKey,
    queuePage,
    queuePageSize,
    queueFrom: params.queueFrom?.toISOString() ?? null,
    queueTo: params.queueTo?.toISOString() ?? null,
    queueStatuses,
    queueKinds,
    queueHolderTypes,
  });

  return getOrComputeCached({
    namespace: "finance-queue",
    key,
    ttlMs: Number(process.env.ANALYTICS_V2_FINANCE_QUEUE_TTL_MS || 60_000),
    compute: async () => {
      const queueWhereParts: Prisma.Sql[] = [Prisma.sql`cc.status IN ('expected', 'held')`];
      const queueReferenceAtSql = Prisma.sql`COALESCE(cc."collectedAt", cc."createdAt", cc."updatedAt")`;
      queueWhereParts.push(...buildScopeQueueWhere(params.scope));

      if (queueStatuses.length) {
        queueWhereParts.push(Prisma.sql`cc.status::text IN (${Prisma.join(queueStatuses)})`);
      }
      if (queueKinds.length) {
        queueWhereParts.push(Prisma.sql`cc.kind::text IN (${Prisma.join(queueKinds)})`);
      }
      if (queueHolderTypes.length) {
        queueWhereParts.push(
          Prisma.sql`cc."currentHolderType"::text IN (${Prisma.join(queueHolderTypes)})`,
        );
      }
      if (params.queueFrom) {
        queueWhereParts.push(Prisma.sql`${queueReferenceAtSql} >= ${params.queueFrom}`);
      }
      if (params.queueTo) {
        queueWhereParts.push(Prisma.sql`${queueReferenceAtSql} < ${params.queueTo}`);
      }

      const [totalRows, queueRows] = await Promise.all([
        prisma.$queryRaw<Array<{ total: bigint }>>(
          Prisma.sql`
            SELECT COUNT(*)::bigint AS total
            FROM "CashCollection" cc
            INNER JOIN "Order" o ON o.id = cc."orderId"
            LEFT JOIN "User" u ON u.id = o."assignedDriverId"
            LEFT JOIN "DriverWarehouseAccess" dwa ON dwa."driverId" = u.id
            WHERE ${Prisma.join(queueWhereParts, " AND ")}
          `,
        ),
        prisma.$queryRaw<
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
            LEFT JOIN "User" ad ON ad.id = o."assignedDriverId"
            LEFT JOIN "DriverWarehouseAccess" dwa ON dwa."driverId" = ad.id
            WHERE ${Prisma.join(queueWhereParts, " AND ")}
            ORDER BY
              ${queueReferenceAtSql} DESC,
              cc."updatedAt" DESC
            LIMIT ${queuePageSize}
            OFFSET ${queueOffset}
          `,
        ),
      ]);

      const now = Date.now();
      const total = Number(totalRows[0]?.total ?? 0);
      const pageCount = Math.max(1, Math.ceil(total / queuePageSize));

      return {
        queue: queueRows.map((row) => {
          const referenceAt = row.referenceAt ?? row.updatedAt;
          const ageHours = Math.max(
            0,
            Math.round((now - new Date(referenceAt).getTime()) / (1000 * 60 * 60)),
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
        queueMeta: {
          page: Math.min(queuePage, pageCount),
          pageSize: queuePageSize,
          total,
          pageCount,
          hasPrev: queuePage > 1,
          hasNext: queuePage < pageCount,
        },
      };
    },
  });
}

