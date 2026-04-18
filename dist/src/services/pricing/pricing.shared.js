"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateOperationalSlaPolicySchema = exports.getOperationalSlaPolicySchema = exports.listDeliverySlaRulesQuerySchema = exports.deliverySlaRuleIdParamSchema = exports.updateDeliverySlaRuleSchema = exports.createDeliverySlaRuleSchema = exports.quoteTariffSchema = exports.listTariffPlansQuerySchema = exports.updateTariffPlanSchema = exports.tariffPlanIdParamSchema = exports.createTariffPlanSchema = exports.tariffRateInputSchema = exports.listZoneMatrixQuerySchema = exports.upsertZoneMatrixSchema = exports.zoneMatrixEntryInputSchema = exports.listPricingRegionsQuerySchema = exports.updatePricingRegionSchema = exports.pricingRegionIdParamSchema = exports.createPricingRegionSchema = exports.TARIFF_PRICE_TYPES = exports.PRICING_PLAN_STATUSES = void 0;
exports.normalizeTariffCode = normalizeTariffCode;
const zod_1 = require("zod");
const order_constants_1 = require("../orders/order.constants");
exports.PRICING_PLAN_STATUSES = ["draft", "active", "archived"];
exports.TARIFF_PRICE_TYPES = ["bucket", "linear"];
const booleanish = zod_1.z.preprocess((value) => {
    if (typeof value === "boolean")
        return value;
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true")
            return true;
        if (normalized === "false")
            return false;
    }
    return value;
}, zod_1.z.boolean());
function normalizeCode(value) {
    return value
        .trim()
        .replace(/[-\s]+/g, "_")
        .replace(/[^A-Za-z0-9_]/g, "")
        .toUpperCase();
}
exports.createPricingRegionSchema = zod_1.z.object({
    code: zod_1.z.string().min(1).max(32).transform(normalizeCode),
    name: zod_1.z.string().trim().min(1).max(120),
    aliases: zod_1.z.array(zod_1.z.string().trim().min(1).max(120)).optional().default([]),
    sortOrder: zod_1.z.coerce.number().int().min(0).default(0),
    isActive: booleanish.optional().default(true),
});
exports.pricingRegionIdParamSchema = zod_1.z.object({
    id: zod_1.z.string().uuid(),
});
exports.updatePricingRegionSchema = exports.createPricingRegionSchema;
exports.listPricingRegionsQuerySchema = zod_1.z.object({
    q: zod_1.z.string().trim().optional(),
    isActive: booleanish.optional(),
});
exports.zoneMatrixEntryInputSchema = zod_1.z.object({
    originRegionId: zod_1.z.string().uuid(),
    destinationRegionId: zod_1.z.string().uuid(),
    zone: zod_1.z.coerce.number().int().min(0).max(99),
});
exports.upsertZoneMatrixSchema = zod_1.z.object({
    entries: zod_1.z.array(exports.zoneMatrixEntryInputSchema).min(1).max(500),
});
exports.listZoneMatrixQuerySchema = zod_1.z.object({
    originRegionId: zod_1.z.string().uuid().optional(),
    destinationRegionId: zod_1.z.string().uuid().optional(),
});
exports.tariffRateInputSchema = zod_1.z
    .object({
    zone: zod_1.z.coerce.number().int().min(0).max(99),
    weightFromKg: zod_1.z.coerce.number().min(0),
    weightToKg: zod_1.z.coerce.number().gt(0),
    price: zod_1.z.coerce.number().min(0),
})
    .superRefine((value, ctx) => {
    if (value.weightToKg <= value.weightFromKg) {
        ctx.addIssue({
            code: "custom",
            message: "weightToKg must be greater than weightFromKg",
            path: ["weightToKg"],
        });
    }
});
exports.createTariffPlanSchema = zod_1.z
    .object({
    name: zod_1.z.string().trim().min(1).max(160),
    code: zod_1.z.string().trim().max(40).optional().nullable(),
    description: zod_1.z.string().trim().max(500).optional().nullable(),
    status: zod_1.z.enum(exports.PRICING_PLAN_STATUSES).default("draft"),
    serviceType: zod_1.z.enum(order_constants_1.SERVICE_TYPES),
    priceType: zod_1.z.enum(exports.TARIFF_PRICE_TYPES).default("bucket"),
    currency: zod_1.z.string().trim().min(3).max(8).default("UZS"),
    priority: zod_1.z.coerce.number().int().min(0).default(0),
    isDefault: booleanish.optional().default(false),
    customerEntityId: zod_1.z.string().uuid().optional().nullable(),
    rates: zod_1.z.array(exports.tariffRateInputSchema).min(1).max(1000),
})
    .superRefine((value, ctx) => {
    const seen = new Set();
    for (const [index, rate] of value.rates.entries()) {
        const key = `${rate.zone}:${rate.weightFromKg}:${rate.weightToKg}`;
        if (seen.has(key)) {
            ctx.addIssue({
                code: "custom",
                message: "Duplicate zone/weight range in tariff rates",
                path: ["rates", index],
            });
        }
        seen.add(key);
    }
});
exports.tariffPlanIdParamSchema = zod_1.z.object({
    id: zod_1.z.string().uuid(),
});
exports.updateTariffPlanSchema = exports.createTariffPlanSchema;
exports.listTariffPlansQuerySchema = zod_1.z.object({
    status: zod_1.z.enum(exports.PRICING_PLAN_STATUSES).optional(),
    serviceType: zod_1.z.enum(order_constants_1.SERVICE_TYPES).optional(),
    customerEntityId: zod_1.z.string().uuid().optional(),
    q: zod_1.z.string().trim().optional(),
});
exports.quoteTariffSchema = zod_1.z.object({
    customerEntityId: zod_1.z.string().uuid().optional().nullable(),
    serviceType: zod_1.z
        .string()
        .optional()
        .nullable()
        .transform((value) => (0, order_constants_1.normalizeServiceTypeInput)(value))
        .pipe(zod_1.z.enum(order_constants_1.SERVICE_TYPES))
        .default(order_constants_1.DEFAULT_SERVICE_TYPE),
    weightKg: zod_1.z.coerce.number().positive().optional().nullable(),
    originQuery: zod_1.z.string().trim().optional().nullable(),
    destinationQuery: zod_1.z.string().trim().optional().nullable(),
});
exports.createDeliverySlaRuleSchema = zod_1.z
    .object({
    name: zod_1.z.string().trim().min(1).max(160),
    description: zod_1.z.string().trim().max(500).optional().nullable(),
    serviceType: zod_1.z.enum(order_constants_1.SERVICE_TYPES),
    originRegionId: zod_1.z.string().uuid().optional().nullable(),
    destinationRegionId: zod_1.z.string().uuid().optional().nullable(),
    zone: zod_1.z.coerce.number().int().min(0).max(99).optional().nullable(),
    deliveryDays: zod_1.z.coerce.number().int().min(1).max(365),
    priority: zod_1.z.coerce.number().int().min(0).default(0),
    isActive: booleanish.optional().default(true),
})
    .superRefine((value, ctx) => {
    const hasOrigin = Boolean(value.originRegionId);
    const hasDestination = Boolean(value.destinationRegionId);
    const hasZone = value.zone !== null && value.zone !== undefined;
    if (hasOrigin !== hasDestination) {
        ctx.addIssue({
            code: "custom",
            message: "originRegionId and destinationRegionId must be provided together",
            path: hasOrigin ? ["destinationRegionId"] : ["originRegionId"],
        });
    }
    if (hasZone && (hasOrigin || hasDestination)) {
        ctx.addIssue({
            code: "custom",
            message: "Zone rule cannot also specify origin/destination regions",
            path: ["zone"],
        });
    }
});
exports.updateDeliverySlaRuleSchema = exports.createDeliverySlaRuleSchema;
exports.deliverySlaRuleIdParamSchema = zod_1.z.object({
    id: zod_1.z.uuid(),
});
exports.listDeliverySlaRulesQuerySchema = zod_1.z.object({
    q: zod_1.z.string().trim().optional(),
    serviceType: zod_1.z.enum(order_constants_1.SERVICE_TYPES).optional(),
    isActive: booleanish.optional(),
});
exports.getOperationalSlaPolicySchema = zod_1.z.object({});
exports.updateOperationalSlaPolicySchema = zod_1.z.object({
    staleHours: zod_1.z.coerce.number().int().min(6).max(720),
    dueSoonHours: zod_1.z.coerce.number().int().min(1).max(168),
    overdueGraceHours: zod_1.z.coerce.number().int().min(0).max(168),
});
function normalizeTariffCode(value) {
    const normalized = normalizeCode(String(value || ""));
    return normalized || null;
}
