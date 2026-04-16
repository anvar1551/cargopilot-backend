"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPricingRegion = createPricingRegion;
exports.updatePricingRegion = updatePricingRegion;
exports.listPricingRegions = listPricingRegions;
exports.upsertZoneMatrix = upsertZoneMatrix;
exports.listZoneMatrix = listZoneMatrix;
exports.createTariffPlan = createTariffPlan;
exports.updateTariffPlan = updateTariffPlan;
exports.listTariffPlans = listTariffPlans;
exports.getTariffPlanById = getTariffPlanById;
exports.quoteTariff = quoteTariff;
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const orderService_shared_1 = require("../orders/orderService.shared");
const pricing_shared_1 = require("./pricing.shared");
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
    const candidates = [
        region.code,
        region.name,
        ...(Array.isArray(region.aliases) ? region.aliases : []),
    ]
        .map((value) => normalizeRegionQuery(value))
        .filter(Boolean);
    return candidates.includes(normalizedQuery);
}
function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}
function sortTariffPlans(plans, customerEntityId) {
    return [...plans].sort((left, right) => {
        const leftSpecific = left.customerEntityId && left.customerEntityId === customerEntityId ? 1 : 0;
        const rightSpecific = right.customerEntityId && right.customerEntityId === customerEntityId ? 1 : 0;
        if (leftSpecific !== rightSpecific)
            return rightSpecific - leftSpecific;
        const leftDefault = left.isDefault ? 1 : 0;
        const rightDefault = right.isDefault ? 1 : 0;
        if (leftDefault !== rightDefault)
            return rightDefault - leftDefault;
        const leftPriority = Number(left.priority ?? 0);
        const rightPriority = Number(right.priority ?? 0);
        if (leftPriority !== rightPriority)
            return rightPriority - leftPriority;
        return new Date(right.createdAt ?? 0).getTime() - new Date(left.createdAt ?? 0).getTime();
    });
}
async function createPricingRegion(input) {
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
async function updatePricingRegion(id, input) {
    const existing = await db.pricingRegion.findUnique({
        where: { id },
        select: { id: true },
    });
    if (!existing) {
        throw (0, orderService_shared_1.orderError)("Pricing region not found", 404);
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
async function listPricingRegions(params) {
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
async function upsertZoneMatrix(input) {
    const regionIds = Array.from(new Set(input.entries.flatMap((entry) => [
        entry.originRegionId,
        entry.destinationRegionId,
    ])));
    const regions = await db.pricingRegion.findMany({
        where: { id: { in: regionIds } },
        select: { id: true },
    });
    const missingRegionIds = regionIds.filter((id) => !regions.some((region) => region.id === id));
    if (missingRegionIds.length > 0) {
        throw (0, orderService_shared_1.orderError)(`Unknown pricingRegionId: ${missingRegionIds.join(", ")}`, 400);
    }
    await db.$transaction(input.entries.map((entry) => db.zoneMatrixEntry.upsert({
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
    })));
    return listZoneMatrix({});
}
async function listZoneMatrix(params) {
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
async function createTariffPlan(input) {
    if (input.customerEntityId) {
        const customerEntity = await db.customerEntity.findUnique({
            where: { id: input.customerEntityId },
            select: { id: true },
        });
        if (!customerEntity) {
            throw (0, orderService_shared_1.orderError)("customerEntityId not found", 400);
        }
    }
    return db.$transaction(async (tx) => {
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
                code: (0, pricing_shared_1.normalizeTariffCode)(input.code),
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
async function updateTariffPlan(id, input) {
    const existing = await db.tariffPlan.findUnique({
        where: { id },
        select: {
            id: true,
            isDefault: true,
        },
    });
    if (!existing) {
        throw (0, orderService_shared_1.orderError)("Tariff plan not found", 404);
    }
    if (input.customerEntityId) {
        const customerEntity = await db.customerEntity.findUnique({
            where: { id: input.customerEntityId },
            select: { id: true },
        });
        if (!customerEntity) {
            throw (0, orderService_shared_1.orderError)("customerEntityId not found", 400);
        }
    }
    return db.$transaction(async (tx) => {
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
                code: (0, pricing_shared_1.normalizeTariffCode)(input.code),
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
async function listTariffPlans(params) {
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
async function getTariffPlanById(id) {
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
async function quoteTariff(input) {
    const weightKg = toNumber(input.weightKg);
    const originQuery = input.originQuery?.trim() ?? "";
    const destinationQuery = input.destinationQuery?.trim() ?? "";
    if (!weightKg || !originQuery || !destinationQuery) {
        return {
            quoteAvailable: false,
            reason: "missing_required_fields",
            serviceType: input.serviceType,
        };
    }
    const regions = await db.pricingRegion.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
    const originRegion = regions.find((region) => matchesRegion(region, originQuery)) ?? null;
    const destinationRegion = regions.find((region) => matchesRegion(region, destinationQuery)) ?? null;
    if (!originRegion) {
        return {
            quoteAvailable: false,
            reason: "origin_region_not_found",
            serviceType: input.serviceType,
        };
    }
    if (!destinationRegion) {
        return {
            quoteAvailable: false,
            reason: "destination_region_not_found",
            serviceType: input.serviceType,
        };
    }
    const zoneEntry = await db.zoneMatrixEntry.findUnique({
        where: {
            originRegionId_destinationRegionId: {
                originRegionId: originRegion.id,
                destinationRegionId: destinationRegion.id,
            },
        },
    });
    if (!zoneEntry) {
        return {
            quoteAvailable: false,
            reason: "zone_not_found",
            serviceType: input.serviceType,
            originRegion: {
                id: originRegion.id,
                code: originRegion.code,
                name: originRegion.name,
            },
            destinationRegion: {
                id: destinationRegion.id,
                code: destinationRegion.code,
                name: destinationRegion.name,
            },
        };
    }
    const plans = await db.tariffPlan.findMany({
        where: {
            status: "active",
            serviceType: input.serviceType,
            OR: input.customerEntityId
                ? [{ customerEntityId: input.customerEntityId }, { customerEntityId: null }]
                : [{ customerEntityId: null }],
        },
        include: {
            rates: {
                where: { zone: zoneEntry.zone },
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
                id: originRegion.id,
                code: originRegion.code,
                name: originRegion.name,
            },
            destinationRegion: {
                id: destinationRegion.id,
                code: destinationRegion.code,
                name: destinationRegion.name,
            },
            zone: zoneEntry.zone,
        };
    }
    const matchedRate = plan.rates.find((rate) => {
        const from = toNumber(rate.weightFromKg) ?? 0;
        const to = toNumber(rate.weightToKg);
        if (to == null)
            return false;
        return weightKg > from && weightKg <= to;
    }) ??
        plan.rates.find((rate) => {
            const from = toNumber(rate.weightFromKg) ?? 0;
            const to = toNumber(rate.weightToKg);
            if (to == null)
                return false;
            return weightKg >= from && weightKg <= to;
        }) ??
        null;
    if (!matchedRate) {
        return {
            quoteAvailable: false,
            reason: "rate_not_found",
            serviceType: input.serviceType,
            originRegion: {
                id: originRegion.id,
                code: originRegion.code,
                name: originRegion.name,
            },
            destinationRegion: {
                id: destinationRegion.id,
                code: destinationRegion.code,
                name: destinationRegion.name,
            },
            zone: zoneEntry.zone,
            tariffPlan: {
                id: plan.id,
                name: plan.name,
                code: plan.code ?? null,
            },
        };
    }
    return {
        quoteAvailable: true,
        reason: null,
        serviceType: input.serviceType,
        weightKg,
        currency: plan.currency,
        serviceCharge: toNumber(matchedRate.price) ?? 0,
        originRegion: {
            id: originRegion.id,
            code: originRegion.code,
            name: originRegion.name,
        },
        destinationRegion: {
            id: destinationRegion.id,
            code: destinationRegion.code,
            name: destinationRegion.name,
        },
        zone: zoneEntry.zone,
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
    };
}
