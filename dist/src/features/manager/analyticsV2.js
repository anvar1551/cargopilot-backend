"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAnalyticsSummaryV2 = getAnalyticsSummaryV2;
exports.getAnalyticsTrendV2 = getAnalyticsTrendV2;
exports.getAnalyticsWarningsV2 = getAnalyticsWarningsV2;
exports.getAnalyticsFinanceQueueV2 = getAnalyticsFinanceQueueV2;
const crypto_1 = require("crypto");
const client_1 = require("@prisma/client");
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const analyticsV2Cache_1 = require("./analyticsV2Cache");
const analyticsReadModel_1 = require("./analyticsReadModel");
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
];
const DEFAULT_SLA_POLICY = {
    staleHours: 48,
    dueSoonHours: 24,
    overdueGraceHours: 0,
};
const UNPAID_PAID_STATUSES = ["NOT_PAID", "PARTIAL"];
const trendBuilds = new Map();
function clampInt(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.min(Math.max(Math.trunc(parsed), min), max);
}
function startOfUtcDay(date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
}
function endOfUtcDay(date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));
}
function subtractDays(date, days) {
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() - days);
    return next;
}
function dayKey(date) {
    return date.toISOString().slice(0, 10);
}
function buildDailyBuckets(start, end) {
    const buckets = [];
    const cursor = startOfUtcDay(start);
    const last = startOfUtcDay(end);
    while (cursor <= last) {
        buckets.push({ date: dayKey(cursor), count: 0 });
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return buckets;
}
function bucketByDay(rows, start, end) {
    const buckets = buildDailyBuckets(start, end);
    const index = new Map(buckets.map((bucket) => [bucket.date, bucket]));
    for (const row of rows) {
        const key = dayKey(startOfUtcDay(row.day));
        const bucket = index.get(key);
        if (bucket)
            bucket.count += row.count;
    }
    return buckets;
}
function emptyTrendPayload(rangeDays) {
    const now = new Date();
    const rangeStart = startOfUtcDay(subtractDays(now, rangeDays - 1));
    const rangeEnd = endOfUtcDay(now);
    return {
        period: {
            rangeDays,
            from: rangeStart.toISOString(),
            to: rangeEnd.toISOString(),
        },
        trend: {
            created: buildDailyBuckets(rangeStart, rangeEnd),
            delivered: buildDailyBuckets(rangeStart, rangeEnd),
        },
        generatedAt: new Date().toISOString(),
        isPartial: true,
    };
}
let cachedPolicy = {
    ...DEFAULT_SLA_POLICY,
    expiresAt: 0,
};
async function getSlaPolicy() {
    const dbPolicyEnabled = process.env.ANALYTICS_SLA_POLICY_DB_ENABLED === "true";
    if (Date.now() < cachedPolicy.expiresAt) {
        return {
            staleHours: cachedPolicy.staleHours,
            dueSoonHours: cachedPolicy.dueSoonHours,
            overdueGraceHours: cachedPolicy.overdueGraceHours,
        };
    }
    if (dbPolicyEnabled) {
        try {
            const db = prismaClient_1.default;
            if (typeof db?.operationalSlaPolicy?.findUnique === "function") {
                const row = await db.operationalSlaPolicy.findUnique({
                    where: { singletonKey: "global" },
                });
                if (row) {
                    cachedPolicy = {
                        staleHours: clampInt(row.staleHours, 6, 720, DEFAULT_SLA_POLICY.staleHours),
                        dueSoonHours: clampInt(row.dueSoonHours, 1, 168, DEFAULT_SLA_POLICY.dueSoonHours),
                        overdueGraceHours: clampInt(row.overdueGraceHours, 0, 168, DEFAULT_SLA_POLICY.overdueGraceHours),
                        expiresAt: Date.now() + 5 * 60000,
                    };
                    return {
                        staleHours: cachedPolicy.staleHours,
                        dueSoonHours: cachedPolicy.dueSoonHours,
                        overdueGraceHours: cachedPolicy.overdueGraceHours,
                    };
                }
            }
        }
        catch (error) {
            const knownSchemaMismatch = error?.code === "P2021" ||
                error?.code === "P2022" ||
                /OperationalSlaPolicy/i.test(String(error?.message ?? ""));
            if (!knownSchemaMismatch) {
                console.error(`[analytics-v2] sla policy load failed: ${error?.message || "unknown"}`);
            }
        }
    }
    cachedPolicy = {
        staleHours: DEFAULT_SLA_POLICY.staleHours,
        dueSoonHours: DEFAULT_SLA_POLICY.dueSoonHours,
        overdueGraceHours: DEFAULT_SLA_POLICY.overdueGraceHours,
        expiresAt: Date.now() + 5 * 60000,
    };
    return {
        staleHours: cachedPolicy.staleHours,
        dueSoonHours: cachedPolicy.dueSoonHours,
        overdueGraceHours: cachedPolicy.overdueGraceHours,
    };
}
function buildScopeOrderWhere(scope) {
    if (scope.role !== "warehouse" || !scope.warehouseId)
        return {};
    return {
        OR: [
            { currentWarehouseId: scope.warehouseId },
            { assignedDriver: { warehouseId: scope.warehouseId } },
            { assignedDriver: { warehouseAccesses: { some: { warehouseId: scope.warehouseId } } } },
        ],
    };
}
function buildScopeOrderSql(scope, orderAlias) {
    if (scope.role !== "warehouse" || !scope.warehouseId) {
        return client_1.Prisma.sql `TRUE`;
    }
    const wid = scope.warehouseId;
    return client_1.Prisma.sql `(
    ${client_1.Prisma.raw(`"${orderAlias}"."currentWarehouseId"`)} = ${wid}::uuid
    OR EXISTS (
      SELECT 1
      FROM "User" ad
      WHERE ad.id = ${client_1.Prisma.raw(`"${orderAlias}"."assignedDriverId"`)}
        AND (
          ad."warehouseId" = ${wid}::uuid
          OR EXISTS (
            SELECT 1
            FROM "DriverWarehouseAccess" dwa
            WHERE dwa."driverId" = ad.id
              AND dwa."warehouseId" = ${wid}::uuid
          )
        )
    )
  )`;
}
function buildScopeQueueSql(scope, orderAlias, assignedDriverAlias) {
    if (scope.role !== "warehouse" || !scope.warehouseId) {
        return client_1.Prisma.sql `TRUE`;
    }
    const wid = scope.warehouseId;
    return client_1.Prisma.sql `(
    ${client_1.Prisma.raw(`"${orderAlias}"."currentWarehouseId"`)} = ${wid}::uuid
    OR ${client_1.Prisma.raw(`"${assignedDriverAlias}"."warehouseId"`)} = ${wid}::uuid
    OR EXISTS (
      SELECT 1
      FROM "DriverWarehouseAccess" dwa
      WHERE dwa."driverId" = ${client_1.Prisma.raw(`"${assignedDriverAlias}"."id"`)}
        AND dwa."warehouseId" = ${wid}::uuid
    )
  )`;
}
function digestFilter(input) {
    return (0, crypto_1.createHash)("sha1").update(JSON.stringify(input)).digest("hex").slice(0, 20);
}
async function getAnalyticsSummaryV2(params) {
    const policy = await getSlaPolicy();
    const rangeDays = clampInt(params.rangeDays ?? 30, 7, 180, 30);
    const staleHours = clampInt(params.staleHours ?? policy.staleHours, 6, 720, policy.staleHours);
    const scopeKey = (0, analyticsV2Cache_1.makeScopeKey)(params.scope);
    const ttlMs = Number(process.env.ANALYTICS_V2_SUMMARY_TTL_MS || 60000);
    const readModelKey = (0, analyticsReadModel_1.getSummaryReadModelKey)({
        scope: scopeKey,
        rangeDays,
        staleHours,
    });
    const readModelHit = await (0, analyticsReadModel_1.readAnalyticsReadModel)(readModelKey);
    if (readModelHit) {
        return { payload: readModelHit, cacheHit: true };
    }
    const key = JSON.stringify({ scopeKey, rangeDays, staleHours });
    const result = await (0, analyticsV2Cache_1.getOrComputeCached)({
        namespace: "summary",
        key,
        ttlMs,
        compute: async () => {
            const now = new Date();
            const rangeStart = startOfUtcDay(subtractDays(now, rangeDays - 1));
            const rangeEnd = endOfUtcDay(now);
            const dueSoonEnd = new Date(now.getTime() + policy.dueSoonHours * 60 * 60 * 1000);
            const overdueBefore = new Date(now.getTime() - policy.overdueGraceHours * 60 * 60 * 1000);
            const staleBefore = new Date(now.getTime() - staleHours * 60 * 60 * 1000);
            const activeStatusesSql = client_1.Prisma.sql `ARRAY[${client_1.Prisma.join(ACTIVE_ORDER_STATUSES.map((status) => client_1.Prisma.sql `${status}`))}]::"OrderStatus"[]`;
            const scopeSql = buildScopeOrderSql(params.scope, "o");
            const [ordersAggRows, invoiceAggRows] = await Promise.all([
                prismaClient_1.default.$queryRaw(client_1.Prisma.sql `
            SELECT
              COUNT(*)::bigint AS "totalOrders",
              COUNT(*) FILTER (
                WHERE o."createdAt" >= ${rangeStart} AND o."createdAt" <= ${rangeEnd}
              )::bigint AS "createdInRange",
              COUNT(*) FILTER (
                WHERE o.status = ANY(${activeStatusesSql})
              )::bigint AS "openOrders",
              COUNT(*) FILTER (
                WHERE o.status = 'delivered'::"OrderStatus"
                  AND o."updatedAt" >= ${rangeStart}
                  AND o."updatedAt" <= ${rangeEnd}
              )::bigint AS "deliveredInRange",
              COUNT(*) FILTER (
                WHERE o.status = 'returned'::"OrderStatus"
                  AND o."updatedAt" >= ${rangeStart}
                  AND o."updatedAt" <= ${rangeEnd}
              )::bigint AS "returnedInRange",
              COUNT(*) FILTER (
                WHERE o.status = 'pending'::"OrderStatus"
              )::bigint AS "pendingOrders",
              COUNT(*) FILTER (
                WHERE o.status = 'at_warehouse'::"OrderStatus"
              )::bigint AS "atWarehouseOrders",
              COUNT(*) FILTER (
                WHERE o.status = 'in_transit'::"OrderStatus"
              )::bigint AS "inTransitOrders",
              COUNT(*) FILTER (
                WHERE o.status = 'out_for_delivery'::"OrderStatus"
              )::bigint AS "outForDeliveryOrders",
              COUNT(*) FILTER (
                WHERE o.status IN ('exception'::"OrderStatus", 'return_in_progress'::"OrderStatus")
              )::bigint AS "exceptionOpenOrders",
              COUNT(*) FILTER (
                WHERE o.status = ANY(${activeStatusesSql})
                  AND o."expectedDeliveryAt" < ${overdueBefore}
              )::bigint AS "overdueOpenOrders",
              COUNT(*) FILTER (
                WHERE o.status = ANY(${activeStatusesSql})
                  AND o."expectedDeliveryAt" >= ${now}
                  AND o."expectedDeliveryAt" <= ${dueSoonEnd}
              )::bigint AS "dueSoonOpenOrders",
              COUNT(*) FILTER (
                WHERE o.status = ANY(${activeStatusesSql})
                  AND o."updatedAt" < ${staleBefore}
              )::bigint AS "staleOpenOrders",
              COALESCE(SUM(o."codAmount") FILTER (
                WHERE o."createdAt" >= ${rangeStart}
                  AND o."createdAt" <= ${rangeEnd}
                  AND o."codAmount" IS NOT NULL
              ), 0)::double precision AS "codExpected",
              COALESCE(SUM(o."serviceCharge") FILTER (
                WHERE o."createdAt" >= ${rangeStart}
                  AND o."createdAt" <= ${rangeEnd}
                  AND o."serviceCharge" IS NOT NULL
              ), 0)::double precision AS "serviceChargeExpected",
              COUNT(*) FILTER (
                WHERE o."createdAt" >= ${rangeStart}
                  AND o."createdAt" <= ${rangeEnd}
                  AND COALESCE(o."codAmount", 0) > 0
                  AND o."codPaidStatus" IN ('NOT_PAID'::"PaidStatus", 'PARTIAL'::"PaidStatus")
              )::bigint AS "unpaidCodCount",
              COUNT(*) FILTER (
                WHERE o."createdAt" >= ${rangeStart}
                  AND o."createdAt" <= ${rangeEnd}
                  AND COALESCE(o."serviceCharge", 0) > 0
                  AND o."serviceChargePaidStatus" IN ('NOT_PAID'::"PaidStatus", 'PARTIAL'::"PaidStatus")
              )::bigint AS "unpaidServiceCount"
            FROM "Order" o
            WHERE ${scopeSql}
          `),
                prismaClient_1.default.$queryRaw(client_1.Prisma.sql `
            SELECT
              COUNT(*) FILTER (
                WHERE i.status = 'pending'::"InvoiceStatus"
                  AND i."createdAt" >= ${rangeStart}
                  AND i."createdAt" <= ${rangeEnd}
              )::bigint AS "pendingInvoicesCount",
              COALESCE(SUM(i.amount) FILTER (
                WHERE i.status = 'paid'::"InvoiceStatus"
                  AND i."createdAt" >= ${rangeStart}
                  AND i."createdAt" <= ${rangeEnd}
              ), 0)::double precision AS "invoicedPaidAmount"
            FROM "Invoice" i
            INNER JOIN "Order" o ON o.id = i."orderId"
            WHERE ${scopeSql}
          `),
            ]);
            const ordersAgg = ordersAggRows[0];
            const invoiceAgg = invoiceAggRows[0];
            const totalOrders = Number(ordersAgg?.totalOrders ?? 0);
            const openOrders = Number(ordersAgg?.openOrders ?? 0);
            const pendingOrders = Number(ordersAgg?.pendingOrders ?? 0);
            const atWarehouseOrders = Number(ordersAgg?.atWarehouseOrders ?? 0);
            const inTransitOrders = Number(ordersAgg?.inTransitOrders ?? 0);
            const outForDeliveryOrders = Number(ordersAgg?.outForDeliveryOrders ?? 0);
            const exceptionOpenOrders = Number(ordersAgg?.exceptionOpenOrders ?? 0);
            const overdueOpenOrders = Number(ordersAgg?.overdueOpenOrders ?? 0);
            const dueSoonOpenOrders = Number(ordersAgg?.dueSoonOpenOrders ?? 0);
            const staleOpenOrders = Number(ordersAgg?.staleOpenOrders ?? 0);
            const createdInRange = Number(ordersAgg?.createdInRange ?? 0);
            const deliveredInRange = Number(ordersAgg?.deliveredInRange ?? 0);
            const returnedInRange = Number(ordersAgg?.returnedInRange ?? 0);
            const pendingInvoicesCount = Number(invoiceAgg?.pendingInvoicesCount ?? 0);
            const invoicedPaidAmount = Number(invoiceAgg?.invoicedPaidAmount ?? 0);
            const serviceChargeExpected = Number(ordersAgg?.serviceChargeExpected ?? 0);
            const codExpected = Number(ordersAgg?.codExpected ?? 0);
            const unpaidServiceCount = Number(ordersAgg?.unpaidServiceCount ?? 0);
            const unpaidCodCount = Number(ordersAgg?.unpaidCodCount ?? 0);
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
                    invoicedPaidAmount,
                    pendingInvoicesCount,
                    serviceChargeExpected,
                    codExpected,
                    unpaidServiceCount,
                    unpaidCodCount,
                },
                generatedAt: new Date().toISOString(),
            };
        },
    });
    await (0, analyticsReadModel_1.writeAnalyticsReadModel)({
        key: readModelKey,
        payload: result.payload,
        ttlMs,
    });
    return result;
}
async function getAnalyticsTrendV2(params) {
    const rangeDays = clampInt(params.rangeDays ?? 30, 7, 180, 30);
    const scopeKey = (0, analyticsV2Cache_1.makeScopeKey)(params.scope);
    const ttlMs = Number(process.env.ANALYTICS_V2_TREND_TTL_MS || 60000);
    const readModelKey = (0, analyticsReadModel_1.getTrendReadModelKey)({
        scope: scopeKey,
        rangeDays,
    });
    const readModelHit = await (0, analyticsReadModel_1.readAnalyticsReadModel)(readModelKey);
    if (readModelHit) {
        return { payload: readModelHit, cacheHit: true };
    }
    const key = JSON.stringify({ scopeKey, rangeDays });
    const build = async () => {
        const result = await (0, analyticsV2Cache_1.getOrComputeCached)({
            namespace: "trend",
            key,
            ttlMs,
            compute: async () => {
                const now = new Date();
                const rangeStart = startOfUtcDay(subtractDays(now, rangeDays - 1));
                const rangeEnd = endOfUtcDay(now);
                const scopeSql = buildScopeOrderSql(params.scope, "o");
                const [createdRows, deliveredRows] = await Promise.all([
                    prismaClient_1.default.$queryRaw(client_1.Prisma.sql `
              SELECT DATE_TRUNC('day', o."createdAt") AS day, COUNT(*)::bigint AS count
              FROM "Order" o
              WHERE o."createdAt" >= ${rangeStart}
                AND o."createdAt" <= ${rangeEnd}
                AND ${scopeSql}
              GROUP BY DATE_TRUNC('day', o."createdAt")
              ORDER BY day ASC
            `),
                    prismaClient_1.default.$queryRaw(client_1.Prisma.sql `
              SELECT DATE_TRUNC('day', o."updatedAt") AS day, COUNT(*)::bigint AS count
              FROM "Order" o
              WHERE o."status" = 'delivered'
                AND o."updatedAt" >= ${rangeStart}
                AND o."updatedAt" <= ${rangeEnd}
                AND ${scopeSql}
              GROUP BY DATE_TRUNC('day', o."updatedAt")
              ORDER BY day ASC
            `),
                ]);
                return {
                    period: {
                        rangeDays,
                        from: rangeStart.toISOString(),
                        to: rangeEnd.toISOString(),
                    },
                    trend: {
                        created: bucketByDay(createdRows.map((row) => ({ day: row.day, count: Number(row.count) })), rangeStart, rangeEnd),
                        delivered: bucketByDay(deliveredRows.map((row) => ({ day: row.day, count: Number(row.count) })), rangeStart, rangeEnd),
                    },
                    generatedAt: new Date().toISOString(),
                };
            },
        });
        await (0, analyticsReadModel_1.writeAnalyticsReadModel)({
            key: readModelKey,
            payload: result.payload,
            ttlMs,
        });
        return result;
    };
    let buildPromise = trendBuilds.get(readModelKey);
    if (!buildPromise) {
        buildPromise = build().finally(() => {
            trendBuilds.delete(readModelKey);
        });
        trendBuilds.set(readModelKey, buildPromise);
    }
    const fastTimeoutMs = Math.max(250, Number(process.env.ANALYTICS_TREND_FAST_TIMEOUT_MS || 1200));
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), fastTimeoutMs));
    const result = await Promise.race([buildPromise, timeout]);
    if (result)
        return result;
    return {
        payload: emptyTrendPayload(rangeDays),
        cacheHit: true,
    };
}
async function getAnalyticsWarningsV2(params) {
    const policy = await getSlaPolicy();
    const rangeDays = clampInt(params.rangeDays ?? 30, 7, 180, 30);
    const staleHours = clampInt(params.staleHours ?? policy.staleHours, 6, 720, policy.staleHours);
    const scopeKey = (0, analyticsV2Cache_1.makeScopeKey)(params.scope);
    const ttlMs = Number(process.env.ANALYTICS_V2_WARNINGS_TTL_MS || 60000);
    const readModelKey = (0, analyticsReadModel_1.getWarningsReadModelKey)({
        scope: scopeKey,
        rangeDays,
        staleHours,
    });
    const readModelHit = await (0, analyticsReadModel_1.readAnalyticsReadModel)(readModelKey);
    if (readModelHit) {
        return { payload: readModelHit, cacheHit: true };
    }
    const key = JSON.stringify({ scopeKey, rangeDays, staleHours });
    const result = await (0, analyticsV2Cache_1.getOrComputeCached)({
        namespace: "warnings",
        key,
        ttlMs,
        compute: async () => {
            const now = new Date();
            const rangeStart = startOfUtcDay(subtractDays(now, rangeDays - 1));
            const rangeEnd = endOfUtcDay(now);
            const overdueBefore = new Date(now.getTime() - policy.overdueGraceHours * 60 * 60 * 1000);
            const staleBefore = new Date(now.getTime() - staleHours * 60 * 60 * 1000);
            const scopeWhere = buildScopeOrderWhere(params.scope);
            const financeExposureWhere = {
                ...scopeWhere,
                createdAt: { gte: rangeStart, lte: rangeEnd },
                OR: [
                    { serviceCharge: { gt: 0 }, serviceChargePaidStatus: { in: UNPAID_PAID_STATUSES } },
                    { codAmount: { gt: 0 }, codPaidStatus: { in: UNPAID_PAID_STATUSES } },
                ],
            };
            const [overdueTotal, staleTotal, financeExposureTotal, overdueOrders, staleOrders, financeExposureOrders] = await Promise.all([
                prismaClient_1.default.order.count({ where: { ...scopeWhere, status: { in: [...ACTIVE_ORDER_STATUSES] }, expectedDeliveryAt: { lt: overdueBefore } } }),
                prismaClient_1.default.order.count({ where: { ...scopeWhere, status: { in: [...ACTIVE_ORDER_STATUSES] }, updatedAt: { lt: staleBefore } } }),
                prismaClient_1.default.order.count({ where: financeExposureWhere }),
                prismaClient_1.default.order.findMany({
                    where: { ...scopeWhere, status: { in: [...ACTIVE_ORDER_STATUSES] }, expectedDeliveryAt: { lt: overdueBefore } },
                    select: { id: true, orderNumber: true, status: true, expectedDeliveryAt: true, updatedAt: true },
                    orderBy: [{ expectedDeliveryAt: "asc" }, { updatedAt: "asc" }],
                    take: 20,
                }),
                prismaClient_1.default.order.findMany({
                    where: { ...scopeWhere, status: { in: [...ACTIVE_ORDER_STATUSES] }, updatedAt: { lt: staleBefore } },
                    select: { id: true, orderNumber: true, status: true, expectedDeliveryAt: true, updatedAt: true },
                    orderBy: [{ updatedAt: "asc" }],
                    take: 20,
                }),
                prismaClient_1.default.order.findMany({
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
                    codDue: order.codAmount && ["NOT_PAID", "PARTIAL"].includes(String(order.codPaidStatus))
                        ? order.codAmount
                        : 0,
                    serviceChargeDue: order.serviceCharge &&
                        ["NOT_PAID", "PARTIAL"].includes(String(order.serviceChargePaidStatus))
                        ? order.serviceCharge
                        : 0,
                    updatedAt: order.updatedAt.toISOString(),
                })),
            };
        },
    });
    await (0, analyticsReadModel_1.writeAnalyticsReadModel)({
        key: readModelKey,
        payload: result.payload,
        ttlMs,
    });
    return result;
}
async function getAnalyticsFinanceQueueV2(params) {
    const queuePageSize = Math.min(Math.max(Number(params.queuePageSize ?? 20) || 20, 5), 200);
    const queuePage = Math.max(Number(params.queuePage ?? 1) || 1, 1);
    const queueOffset = (queuePage - 1) * queuePageSize;
    const scopeKey = (0, analyticsV2Cache_1.makeScopeKey)(params.scope);
    const ttlMs = Number(process.env.ANALYTICS_V2_FINANCE_QUEUE_TTL_MS || 60000);
    const queueStatuses = Array.from(new Set((params.queueStatuses ?? []).filter((v) => v === "expected" || v === "held")));
    const queueKinds = Array.from(new Set((params.queueKinds ?? []).filter((v) => v === "cod" || v === "service_charge")));
    const queueHolderTypes = Array.from(new Set((params.queueHolderTypes ?? []).filter((v) => ["none", "driver", "warehouse", "pickup_point", "finance"].includes(v))));
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
    const filterHash = digestFilter({
        scopeKey,
        queueFrom: params.queueFrom?.toISOString() ?? null,
        queueTo: params.queueTo?.toISOString() ?? null,
        queueStatuses,
        queueKinds,
        queueHolderTypes,
        queuePageSize,
    });
    const readModelKey = (0, analyticsReadModel_1.getFinanceQueueReadModelKey)({
        scope: scopeKey,
        filterHash,
        page: queuePage,
    });
    const readModelHit = await (0, analyticsReadModel_1.readAnalyticsReadModel)(readModelKey);
    if (readModelHit) {
        return { payload: readModelHit, cacheHit: true };
    }
    const result = await (0, analyticsV2Cache_1.getOrComputeCached)({
        namespace: "finance-queue",
        key,
        ttlMs,
        compute: async () => {
            const queueWhereParts = [client_1.Prisma.sql `cc.status IN ('expected', 'held')`];
            const queueReferenceAtSql = client_1.Prisma.sql `COALESCE(cc."collectedAt", cc."createdAt", cc."updatedAt")`;
            if (queueStatuses.length) {
                queueWhereParts.push(client_1.Prisma.sql `cc.status::text IN (${client_1.Prisma.join(queueStatuses)})`);
            }
            if (queueKinds.length) {
                queueWhereParts.push(client_1.Prisma.sql `cc.kind::text IN (${client_1.Prisma.join(queueKinds)})`);
            }
            if (queueHolderTypes.length) {
                queueWhereParts.push(client_1.Prisma.sql `cc."currentHolderType"::text IN (${client_1.Prisma.join(queueHolderTypes)})`);
            }
            if (params.queueFrom) {
                queueWhereParts.push(client_1.Prisma.sql `${queueReferenceAtSql} >= ${params.queueFrom}`);
            }
            if (params.queueTo) {
                queueWhereParts.push(client_1.Prisma.sql `${queueReferenceAtSql} < ${params.queueTo}`);
            }
            queueWhereParts.push(buildScopeQueueSql(params.scope, "o", "ad"));
            const [totalRows, queueRows] = await Promise.all([
                prismaClient_1.default.$queryRaw(client_1.Prisma.sql `
            SELECT COUNT(*)::bigint AS total
            FROM "CashCollection" cc
            INNER JOIN "Order" o ON o.id = cc."orderId"
            LEFT JOIN "User" ad ON ad.id = o."assignedDriverId"
            WHERE ${client_1.Prisma.join(queueWhereParts, " AND ")}
          `),
                prismaClient_1.default.$queryRaw(client_1.Prisma.sql `
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
            WHERE ${client_1.Prisma.join(queueWhereParts, " AND ")}
            ORDER BY
              ${queueReferenceAtSql} DESC,
              cc."updatedAt" DESC
            LIMIT ${queuePageSize}
            OFFSET ${queueOffset}
          `),
            ]);
            const now = Date.now();
            const total = Number(totalRows[0]?.total ?? 0);
            const pageCount = Math.max(1, Math.ceil(total / queuePageSize));
            return {
                queue: queueRows.map((row) => {
                    const referenceAt = row.referenceAt ?? row.updatedAt;
                    const ageHours = Math.max(0, Math.round((now - new Date(referenceAt).getTime()) / (1000 * 60 * 60)));
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
    await (0, analyticsReadModel_1.writeAnalyticsReadModel)({
        key: readModelKey,
        payload: result.payload,
        ttlMs,
    });
    return result;
}
