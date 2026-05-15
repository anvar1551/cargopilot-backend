"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveOrderSlaSnapshot = resolveOrderSlaSnapshot;
const client_1 = require("@prisma/client");
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const db = prismaClient_1.default;
function normalizeRegionQuery(value) {
    return String(value || "")
        .trim()
        .replace(/\s+/g, " ")
        .toUpperCase();
}
function matchesRegion(region, query) {
    const normalizedQuery = normalizeRegionQuery(query);
    if (!normalizedQuery)
        return false;
    const candidates = [region.code, region.name, ...(Array.isArray(region.aliases) ? region.aliases : [])]
        .map((value) => normalizeRegionQuery(value))
        .filter(Boolean);
    return candidates.includes(normalizedQuery);
}
function toDateOrNull(value) {
    if (value === undefined || value === null)
        return null;
    if (value instanceof Date)
        return Number.isNaN(value.getTime()) ? null : value;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}
function addDaysUtc(baseDate, days) {
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
async function resolvePricingRouteContext(params) {
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
    const originRegion = regions.find((region) => matchesRegion(region, originQuery)) ?? null;
    const destinationRegion = regions.find((region) => matchesRegion(region, destinationQuery)) ?? null;
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
function rankDeliverySlaRule(rule, routeContext) {
    const isExactRoute = Boolean(rule.originRegionId) &&
        Boolean(rule.destinationRegionId) &&
        rule.originRegionId === routeContext.originRegion?.id &&
        rule.destinationRegionId === routeContext.destinationRegion?.id;
    if (isExactRoute)
        return 3;
    const isZoneRule = rule.zone !== null &&
        rule.zone !== undefined &&
        routeContext.zoneEntry?.zone !== undefined &&
        rule.zone === routeContext.zoneEntry.zone &&
        !rule.originRegionId &&
        !rule.destinationRegionId;
    if (isZoneRule)
        return 2;
    const isServiceDefault = (rule.zone === null || rule.zone === undefined) &&
        !rule.originRegionId &&
        !rule.destinationRegionId;
    if (isServiceDefault)
        return 1;
    return 0;
}
function pickBestDeliverySlaRule(rules, routeContext) {
    return [...rules].sort((left, right) => {
        const leftRank = rankDeliverySlaRule(left, routeContext);
        const rightRank = rankDeliverySlaRule(right, routeContext);
        if (leftRank !== rightRank)
            return rightRank - leftRank;
        const leftPriority = Number(left.priority ?? 0);
        const rightPriority = Number(right.priority ?? 0);
        if (leftPriority !== rightPriority)
            return rightPriority - leftPriority;
        return new Date(right.createdAt ?? 0).getTime() - new Date(left.createdAt ?? 0).getTime();
    })[0] ?? null;
}
async function resolveOrderSlaSnapshot(input) {
    const createdAt = input.createdAt ?? new Date();
    const promiseDate = toDateOrNull(input.promiseDate);
    if (promiseDate) {
        return {
            expectedDeliveryAt: promiseDate,
            slaSource: client_1.OrderSlaSource.PROMISE_DATE,
            slaRuleId: null,
            slaTargetDays: null,
        };
    }
    if (!input.serviceType) {
        return {
            expectedDeliveryAt: null,
            slaSource: client_1.OrderSlaSource.NONE,
            slaRuleId: null,
            slaTargetDays: null,
        };
    }
    const routeContext = await resolvePricingRouteContext({
        originQuery: input.originQuery,
        destinationQuery: input.destinationQuery,
    });
    const ruleOrClauses = [
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
            serviceType: input.serviceType,
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
            slaSource: client_1.OrderSlaSource.NONE,
            slaRuleId: null,
            slaTargetDays: null,
        };
    }
    return {
        expectedDeliveryAt: addDaysUtc(createdAt, matchedRule.deliveryDays),
        slaSource: client_1.OrderSlaSource.SLA_RULE,
        slaRuleId: matchedRule.id,
        slaTargetDays: matchedRule.deliveryDays,
    };
}
