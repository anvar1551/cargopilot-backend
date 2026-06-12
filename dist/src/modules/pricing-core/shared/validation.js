"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.backfillOrderSlaSchema = exports.updateOperationalSlaPolicySchema = exports.getOperationalSlaPolicySchema = exports.listDeliverySlaRulesQuerySchema = exports.deliverySlaRuleIdParamSchema = exports.updateDeliverySlaRuleSchema = exports.createDeliverySlaRuleSchema = exports.quoteTariffOptionsSchema = exports.quoteTariffSchema = exports.listTariffPlansQuerySchema = exports.updateTariffPlanSchema = exports.tariffPlanIdParamSchema = exports.createTariffPlanSchema = exports.transitLegRateInputSchema = exports.tariffRateInputSchema = exports.listZoneMatrixQuerySchema = exports.upsertZoneMatrixSchema = exports.zoneMatrixEntryInputSchema = exports.listPricingRegionsQuerySchema = exports.updatePricingRegionSchema = exports.pricingRegionIdParamSchema = exports.createPricingRegionSchema = exports.TARIFF_TRANSPORT_MODES = exports.TARIFF_PRICING_STRATEGIES = exports.TARIFF_COVERAGE_TYPES = exports.TARIFF_PRICE_TYPES = exports.PRICING_PLAN_STATUSES = void 0;
exports.normalizeTariffCode = normalizeTariffCode;
exports.normalizeCountryCode = normalizeCountryCode;
const zod_1 = require("zod");
const order_constants_1 = require("../../orders-core/domain/order.constants");
exports.PRICING_PLAN_STATUSES = ["draft", "active", "archived"];
exports.TARIFF_PRICE_TYPES = ["bucket", "linear"];
exports.TARIFF_COVERAGE_TYPES = ["domestic", "international"];
exports.TARIFF_PRICING_STRATEGIES = ["FIXED_LANE", "LEG_TRANSIT"];
exports.TARIFF_TRANSPORT_MODES = [
    "ROAD",
    "AIR",
    "SEA",
    "RAIL",
    "COURIER",
    "MULTIMODAL",
];
const SUPPORTED_CURRENCY_CODES = ["UZS", "USD", "CNY"];
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
    cursor: zod_1.z.string().uuid().optional(),
    limit: zod_1.z.coerce.number().int().min(1).max(100).optional(),
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
exports.transitLegRateInputSchema = zod_1.z
    .object({
    sequence: zod_1.z.coerce.number().int().min(1),
    legCode: zod_1.z.string().trim().min(1).max(48),
    label: zod_1.z.string().trim().max(120).optional().nullable(),
    mode: zod_1.z
        .string()
        .trim()
        .transform((value) => value.toUpperCase())
        .pipe(zod_1.z.enum(exports.TARIFF_TRANSPORT_MODES))
        .optional()
        .nullable(),
    originCountryCode: zod_1.z
        .string()
        .trim()
        .transform((value) => value.toUpperCase())
        .pipe(zod_1.z.string().regex(/^[A-Z]{2}$/))
        .optional()
        .nullable(),
    destinationCountryCode: zod_1.z
        .string()
        .trim()
        .transform((value) => value.toUpperCase())
        .pipe(zod_1.z.string().regex(/^[A-Z]{2}$/))
        .optional()
        .nullable(),
    ratePerKg: zod_1.z.coerce.number().min(0),
    minCharge: zod_1.z.coerce.number().min(0).optional().nullable(),
    flatFee: zod_1.z.coerce.number().min(0).optional().nullable(),
})
    .superRefine((value, ctx) => {
    if (!value.originCountryCode || !value.destinationCountryCode) {
        ctx.addIssue({
            code: "custom",
            message: "originCountryCode and destinationCountryCode are required for each transit leg",
            path: ["originCountryCode"],
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
    pricingStrategy: zod_1.z.enum(exports.TARIFF_PRICING_STRATEGIES).default("FIXED_LANE"),
    coverageType: zod_1.z.enum(exports.TARIFF_COVERAGE_TYPES).default("domestic"),
    transportMode: zod_1.z
        .string()
        .trim()
        .transform((value) => value.toUpperCase())
        .pipe(zod_1.z.enum(exports.TARIFF_TRANSPORT_MODES))
        .default("ROAD"),
    originCountryCode: zod_1.z
        .string()
        .trim()
        .transform((value) => value.toUpperCase())
        .pipe(zod_1.z.string().regex(/^[A-Z]{2}$/))
        .optional()
        .nullable(),
    destinationCountryCode: zod_1.z
        .string()
        .trim()
        .transform((value) => value.toUpperCase())
        .pipe(zod_1.z.string().regex(/^[A-Z]{2}$/))
        .optional()
        .nullable(),
    routeTemplateId: zod_1.z.string().uuid().optional().nullable(),
    currency: zod_1.z
        .string()
        .trim()
        .transform((value) => value.toUpperCase())
        .pipe(zod_1.z.enum(SUPPORTED_CURRENCY_CODES))
        .default("UZS"),
    priority: zod_1.z.coerce.number().int().min(0).default(0),
    isDefault: booleanish.optional().default(false),
    customerEntityId: zod_1.z.string().uuid().optional().nullable(),
    rates: zod_1.z.array(exports.tariffRateInputSchema).min(0).max(1000),
    transitLegRates: zod_1.z.array(exports.transitLegRateInputSchema).max(50).optional().default([]),
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
    if (value.coverageType === "domestic" &&
        (value.originCountryCode || value.destinationCountryCode)) {
        ctx.addIssue({
            code: "custom",
            message: "originCountryCode/destinationCountryCode can only be used for international coverageType",
            path: ["coverageType"],
        });
    }
    if (value.pricingStrategy === "FIXED_LANE" && value.rates.length === 0) {
        ctx.addIssue({
            code: "custom",
            message: "rates are required for FIXED_LANE pricing strategy",
            path: ["rates"],
        });
    }
    if (value.pricingStrategy === "LEG_TRANSIT" &&
        (!value.transitLegRates || value.transitLegRates.length === 0)) {
        ctx.addIssue({
            code: "custom",
            message: "transitLegRates are required for LEG_TRANSIT pricing strategy",
            path: ["transitLegRates"],
        });
    }
    if (value.pricingStrategy === "LEG_TRANSIT" && value.transitLegRates.length > 0) {
        if (value.coverageType !== "international") {
            ctx.addIssue({
                code: "custom",
                message: "LEG_TRANSIT strategy requires coverageType=international",
                path: ["coverageType"],
            });
        }
        if (!value.originCountryCode || !value.destinationCountryCode) {
            ctx.addIssue({
                code: "custom",
                message: "originCountryCode and destinationCountryCode are required for LEG_TRANSIT strategy",
                path: ["originCountryCode"],
            });
            return;
        }
        const sorted = [...value.transitLegRates].sort((a, b) => a.sequence - b.sequence);
        const seenSeq = new Set();
        const seenCodes = new Set();
        for (let index = 0; index < sorted.length; index += 1) {
            const leg = sorted[index];
            if (seenSeq.has(leg.sequence)) {
                ctx.addIssue({
                    code: "custom",
                    message: `Duplicate transit leg sequence: ${leg.sequence}`,
                    path: ["transitLegRates", index, "sequence"],
                });
            }
            seenSeq.add(leg.sequence);
            const codeKey = leg.legCode.trim().toLowerCase();
            if (seenCodes.has(codeKey)) {
                ctx.addIssue({
                    code: "custom",
                    message: `Duplicate transit leg code: ${leg.legCode}`,
                    path: ["transitLegRates", index, "legCode"],
                });
            }
            seenCodes.add(codeKey);
            const expectedSequence = index + 1;
            if (leg.sequence !== expectedSequence) {
                ctx.addIssue({
                    code: "custom",
                    message: "Transit leg sequence must be continuous and start from 1 (1..N)",
                    path: ["transitLegRates", index, "sequence"],
                });
            }
            if (index === 0 && leg.originCountryCode !== value.originCountryCode) {
                ctx.addIssue({
                    code: "custom",
                    message: "First transit leg originCountryCode must match tariff originCountryCode",
                    path: ["transitLegRates", index, "originCountryCode"],
                });
            }
            if (index === sorted.length - 1 &&
                leg.destinationCountryCode !== value.destinationCountryCode) {
                ctx.addIssue({
                    code: "custom",
                    message: "Last transit leg destinationCountryCode must match tariff destinationCountryCode",
                    path: ["transitLegRates", index, "destinationCountryCode"],
                });
            }
            if (index > 0) {
                const prev = sorted[index - 1];
                if (prev.destinationCountryCode !== leg.originCountryCode) {
                    ctx.addIssue({
                        code: "custom",
                        message: "Transit leg chain is broken: previous destinationCountryCode must equal next originCountryCode",
                        path: ["transitLegRates", index, "originCountryCode"],
                    });
                }
            }
        }
    }
});
exports.tariffPlanIdParamSchema = zod_1.z.object({
    id: zod_1.z.string().uuid(),
});
exports.updateTariffPlanSchema = exports.createTariffPlanSchema;
exports.listTariffPlansQuerySchema = zod_1.z.object({
    status: zod_1.z.enum(exports.PRICING_PLAN_STATUSES).optional(),
    serviceType: zod_1.z.enum(order_constants_1.SERVICE_TYPES).optional(),
    pricingStrategy: zod_1.z.enum(exports.TARIFF_PRICING_STRATEGIES).optional(),
    coverageType: zod_1.z.enum(exports.TARIFF_COVERAGE_TYPES).optional(),
    transportMode: zod_1.z
        .string()
        .trim()
        .transform((value) => value.toUpperCase())
        .pipe(zod_1.z.enum(exports.TARIFF_TRANSPORT_MODES))
        .optional(),
    customerEntityId: zod_1.z.string().uuid().optional(),
    routeTemplateId: zod_1.z.string().uuid().optional(),
    q: zod_1.z.string().trim().optional(),
    cursor: zod_1.z.string().uuid().optional(),
    limit: zod_1.z.coerce.number().int().min(1).max(100).optional(),
});
exports.quoteTariffSchema = zod_1.z.object({
    companyId: zod_1.z.string().uuid().optional().nullable(),
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
    originCountryCode: zod_1.z
        .string()
        .trim()
        .transform((value) => value.toUpperCase())
        .optional()
        .nullable(),
    destinationCountryCode: zod_1.z
        .string()
        .trim()
        .transform((value) => value.toUpperCase())
        .optional()
        .nullable(),
    transportMode: zod_1.z
        .string()
        .trim()
        .transform((value) => value.toUpperCase())
        .pipe(zod_1.z.enum(exports.TARIFF_TRANSPORT_MODES))
        .optional()
        .nullable(),
});
exports.quoteTariffOptionsSchema = exports.quoteTariffSchema.omit({
    transportMode: true,
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
    cursor: zod_1.z.string().uuid().optional(),
    limit: zod_1.z.coerce.number().int().min(1).max(100).optional(),
});
exports.getOperationalSlaPolicySchema = zod_1.z.object({});
exports.updateOperationalSlaPolicySchema = zod_1.z.object({
    staleHours: zod_1.z.coerce.number().int().min(6).max(720),
    dueSoonHours: zod_1.z.coerce.number().int().min(1).max(168),
    overdueGraceHours: zod_1.z.coerce.number().int().min(0).max(168),
});
exports.backfillOrderSlaSchema = zod_1.z.object({
    limit: zod_1.z.coerce.number().int().min(1).max(5000).default(500),
    dryRun: booleanish.optional().default(true),
});
function normalizeTariffCode(value) {
    const normalized = normalizeCode(String(value || ""));
    return normalized || null;
}
function normalizeCountryCode(value) {
    const normalized = String(value || "").trim().toUpperCase();
    if (!normalized)
        return null;
    if (/^[A-Z]{2}$/.test(normalized))
        return normalized;
    const aliases = {
        UZB: "UZ",
        UZBEKISTAN: "UZ",
        CHN: "CN",
        CHINA: "CN",
        PRC: "CN",
        USA: "US",
        UNITED_STATES: "US",
        UNITED_STATES_OF_AMERICA: "US",
        RUS: "RU",
        RUSSIA: "RU",
    };
    const key = normalized.replace(/[\s-]+/g, "_");
    return aliases[key] ?? null;
}
