"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getManagerAnalyticsSummary = getManagerAnalyticsSummary;
const client_1 = require("@prisma/client");
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const db = prismaClient_1.default;
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
    singletonKey: "global",
    staleHours: 48,
    dueSoonHours: 24,
    overdueGraceHours: 0,
};
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
async function getManagerAnalyticsSummary(params) {
    let policy = {
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
                staleHours: clampInt(policyRow?.staleHours, 6, 720, DEFAULT_SLA_POLICY.staleHours),
                dueSoonHours: clampInt(policyRow?.dueSoonHours, 1, 168, DEFAULT_SLA_POLICY.dueSoonHours),
                overdueGraceHours: clampInt(policyRow?.overdueGraceHours, 0, 168, DEFAULT_SLA_POLICY.overdueGraceHours),
            };
        }
    }
    catch (error) {
        const knownSchemaMismatch = error?.code === "P2021" ||
            error?.code === "P2022" ||
            /OperationalSlaPolicy/i.test(String(error?.message ?? ""));
        if (!knownSchemaMismatch) {
            throw error;
        }
    }
    const rangeDays = clampInt(params?.rangeDays ?? 30, 7, 180, 30);
    const staleHours = clampInt(params?.staleHours ?? policy.staleHours, 6, 720, policy.staleHours);
    const queuePageSize = Math.min(Math.max(Number(params?.queuePageSize ?? params?.queueLimit ?? 20) || 20, 5), 200);
    const queuePage = Math.max(Number(params?.queuePage ?? 1) || 1, 1);
    const queueOffset = (queuePage - 1) * queuePageSize;
    const queueStatuses = Array.from(new Set((params?.queueStatuses ?? []).filter((v) => v === "expected" || v === "held")));
    const queueKinds = Array.from(new Set((params?.queueKinds ?? []).filter((v) => v === "cod" || v === "service_charge")));
    const queueHolderTypes = Array.from(new Set((params?.queueHolderTypes ?? []).filter((v) => ["none", "driver", "warehouse", "pickup_point", "finance"].includes(v))));
    const now = new Date();
    const rangeStart = startOfUtcDay(subtractDays(now, rangeDays - 1));
    const rangeEnd = endOfUtcDay(now);
    const overdueBefore = new Date(now.getTime() - policy.overdueGraceHours * 60 * 60 * 1000);
    const dueSoonEnd = new Date(now.getTime() + policy.dueSoonHours * 60 * 60 * 1000);
    const staleBefore = new Date(now.getTime() - staleHours * 60 * 60 * 1000);
    const createdTrendPromise = prismaClient_1.default.$queryRaw(client_1.Prisma.sql `
      SELECT DATE_TRUNC('day', "createdAt") AS day, COUNT(*)::bigint AS count
      FROM "Order"
      WHERE "createdAt" >= ${rangeStart} AND "createdAt" <= ${rangeEnd}
      GROUP BY DATE_TRUNC('day', "createdAt")
      ORDER BY day ASC
    `);
    const deliveredTrendPromise = prismaClient_1.default.$queryRaw(client_1.Prisma.sql `
      SELECT DATE_TRUNC('day', "updatedAt") AS day, COUNT(*)::bigint AS count
      FROM "Order"
      WHERE "status" = 'delivered'
        AND "updatedAt" >= ${rangeStart}
        AND "updatedAt" <= ${rangeEnd}
      GROUP BY DATE_TRUNC('day', "updatedAt")
      ORDER BY day ASC
    `);
    const cashCustodySnapshotPromise = prismaClient_1.default.$queryRaw(client_1.Prisma.sql `
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
    `);
    const cashHolderBreakdownPromise = prismaClient_1.default.$queryRaw(client_1.Prisma.sql `
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
    `);
    const queueWhereParts = [
        client_1.Prisma.sql `cc.status IN ('expected', 'held')`,
    ];
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
    if (params?.queueFrom) {
        queueWhereParts.push(client_1.Prisma.sql `${queueReferenceAtSql} >= ${params.queueFrom}`);
    }
    if (params?.queueTo) {
        queueWhereParts.push(client_1.Prisma.sql `${queueReferenceAtSql} < ${params.queueTo}`);
    }
    const cashOpenQueueTotalPromise = prismaClient_1.default.$queryRaw(client_1.Prisma.sql `
      SELECT COUNT(*)::bigint AS total
      FROM "CashCollection" cc
      INNER JOIN "Order" o ON o.id = cc."orderId"
      WHERE ${client_1.Prisma.join(queueWhereParts, " AND ")}
    `);
    const cashOpenQueuePromise = prismaClient_1.default.$queryRaw(client_1.Prisma.sql `
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
      WHERE ${client_1.Prisma.join(queueWhereParts, " AND ")}
      ORDER BY
        ${queueReferenceAtSql} DESC,
        cc."updatedAt" DESC
      LIMIT ${queuePageSize}
      OFFSET ${queueOffset}
    `);
    const [totalOrders, createdInRange, openOrders, overdueOpenOrders, dueTodayOpenOrders, staleOpenOrders, promiseBackedOrders, pendingOrders, atWarehouseOrders, inTransitOrders, outForDeliveryOrders, exceptionOpenOrders, warehouseAtWarehouseOrders, pickupPointAtWarehouseOrders, warehouseOutForDeliveryOrders, pickupPointOutForDeliveryOrders, warehouseActiveOrders, pickupPointActiveOrders, deliveredInRange, warehouseDeliveredInRange, pickupPointDeliveredInRange, returnedInRange, serviceChargeExpected, codExpected, unpaidServiceCount, unpaidCodCount, paidInvoices, pendingInvoicesCount, statusDistribution, serviceTypeDistribution, createdTrendRows, deliveredTrendRows, cashCustodySnapshotRows, cashHolderBreakdownRows, cashOpenQueueTotalRows, cashOpenQueueRows,] = await Promise.all([
        prismaClient_1.default.order.count(),
        prismaClient_1.default.order.count({
            where: { createdAt: { gte: rangeStart, lte: rangeEnd } },
        }),
        prismaClient_1.default.order.count({
            where: { status: { in: [...ACTIVE_ORDER_STATUSES] } },
        }),
        prismaClient_1.default.order.count({
            where: {
                status: { in: [...ACTIVE_ORDER_STATUSES] },
                expectedDeliveryAt: { lt: overdueBefore },
            },
        }),
        prismaClient_1.default.order.count({
            where: {
                status: { in: [...ACTIVE_ORDER_STATUSES] },
                expectedDeliveryAt: { gte: now, lte: dueSoonEnd },
            },
        }),
        prismaClient_1.default.order.count({
            where: {
                status: { in: [...ACTIVE_ORDER_STATUSES] },
                updatedAt: { lt: staleBefore },
            },
        }),
        prismaClient_1.default.order.count({
            where: { slaSource: "PROMISE_DATE" },
        }),
        prismaClient_1.default.order.count({ where: { status: "pending" } }),
        prismaClient_1.default.order.count({ where: { status: "at_warehouse" } }),
        prismaClient_1.default.order.count({ where: { status: "in_transit" } }),
        prismaClient_1.default.order.count({ where: { status: "out_for_delivery" } }),
        prismaClient_1.default.order.count({
            where: { status: { in: ["exception", "return_in_progress"] } },
        }),
        prismaClient_1.default.order.count({
            where: {
                status: "at_warehouse",
                currentWarehouse: { type: "warehouse" },
            },
        }),
        prismaClient_1.default.order.count({
            where: {
                status: "at_warehouse",
                currentWarehouse: { type: "pickup_point" },
            },
        }),
        prismaClient_1.default.order.count({
            where: {
                status: "out_for_delivery",
                currentWarehouse: { type: "warehouse" },
            },
        }),
        prismaClient_1.default.order.count({
            where: {
                status: "out_for_delivery",
                currentWarehouse: { type: "pickup_point" },
            },
        }),
        prismaClient_1.default.order.count({
            where: {
                status: { in: [...ACTIVE_ORDER_STATUSES] },
                currentWarehouse: { type: "warehouse" },
            },
        }),
        prismaClient_1.default.order.count({
            where: {
                status: { in: [...ACTIVE_ORDER_STATUSES] },
                currentWarehouse: { type: "pickup_point" },
            },
        }),
        prismaClient_1.default.order.count({
            where: {
                status: "delivered",
                updatedAt: { gte: rangeStart, lte: rangeEnd },
            },
        }),
        prismaClient_1.default.order.count({
            where: {
                status: "delivered",
                updatedAt: { gte: rangeStart, lte: rangeEnd },
                currentWarehouse: { type: "warehouse" },
            },
        }),
        prismaClient_1.default.order.count({
            where: {
                status: "delivered",
                updatedAt: { gte: rangeStart, lte: rangeEnd },
                currentWarehouse: { type: "pickup_point" },
            },
        }),
        prismaClient_1.default.order.count({
            where: {
                status: "returned",
                updatedAt: { gte: rangeStart, lte: rangeEnd },
            },
        }),
        prismaClient_1.default.order.aggregate({
            _sum: { serviceCharge: true },
            where: {
                createdAt: { gte: rangeStart, lte: rangeEnd },
                serviceCharge: { not: null },
            },
        }),
        prismaClient_1.default.order.aggregate({
            _sum: { codAmount: true },
            where: {
                createdAt: { gte: rangeStart, lte: rangeEnd },
                codAmount: { not: null },
            },
        }),
        prismaClient_1.default.order.count({
            where: {
                createdAt: { gte: rangeStart, lte: rangeEnd },
                serviceCharge: { gt: 0 },
                serviceChargePaidStatus: { in: ["NOT_PAID", "PARTIAL"] },
            },
        }),
        prismaClient_1.default.order.count({
            where: {
                createdAt: { gte: rangeStart, lte: rangeEnd },
                codAmount: { gt: 0 },
                codPaidStatus: { in: ["NOT_PAID", "PARTIAL"] },
            },
        }),
        prismaClient_1.default.invoice.aggregate({
            _sum: { amount: true },
            where: {
                status: "paid",
                createdAt: { gte: rangeStart, lte: rangeEnd },
            },
        }),
        prismaClient_1.default.invoice.count({
            where: {
                status: "pending",
                createdAt: { gte: rangeStart, lte: rangeEnd },
            },
        }),
        prismaClient_1.default.order.groupBy({
            by: ["status"],
            _count: { _all: true },
        }),
        prismaClient_1.default.order.groupBy({
            by: ["serviceType"],
            _count: { _all: true },
            where: {
                createdAt: { gte: rangeStart, lte: rangeEnd },
                serviceType: { not: null },
            },
        }),
        createdTrendPromise,
        deliveredTrendPromise,
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
                const ageHours = Math.max(0, Math.round((now.getTime() - new Date(referenceAt).getTime()) / (1000 * 60 * 60)));
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
        trend: {
            created: bucketByDay(createdTrendRows.map((row) => ({
                day: row.day,
                count: Number(row.count),
            })), rangeStart, rangeEnd),
            delivered: bucketByDay(deliveredTrendRows.map((row) => ({
                day: row.day,
                count: Number(row.count),
            })), rangeStart, rangeEnd),
        },
    };
}
