import { z } from "zod";
import {
  DEFAULT_SERVICE_TYPE,
  SERVICE_TYPES,
  normalizeServiceTypeInput,
} from "../../orders-core/domain/order.constants";

export const PRICING_PLAN_STATUSES = ["draft", "active", "archived"] as const;
export const TARIFF_PRICE_TYPES = ["bucket", "linear"] as const;
export const TARIFF_COVERAGE_TYPES = ["domestic", "international"] as const;
export const TARIFF_PRICING_STRATEGIES = ["FIXED_LANE", "LEG_TRANSIT"] as const;
export const TARIFF_TRANSPORT_MODES = [
  "ROAD",
  "AIR",
  "SEA",
  "RAIL",
  "COURIER",
  "MULTIMODAL",
] as const;
const SUPPORTED_CURRENCY_CODES = ["UZS", "USD", "CNY"] as const;

const booleanish = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return value;
}, z.boolean());

function normalizeCode(value: string) {
  return value
    .trim()
    .replace(/[-\s]+/g, "_")
    .replace(/[^A-Za-z0-9_]/g, "")
    .toUpperCase();
}

export const createPricingRegionSchema = z.object({
  code: z.string().min(1).max(32).transform(normalizeCode),
  name: z.string().trim().min(1).max(120),
  aliases: z.array(z.string().trim().min(1).max(120)).optional().default([]),
  sortOrder: z.coerce.number().int().min(0).default(0),
  isActive: booleanish.optional().default(true),
});

export const pricingRegionIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const updatePricingRegionSchema = createPricingRegionSchema;

export const listPricingRegionsQuerySchema = z.object({
  q: z.string().trim().optional(),
  isActive: booleanish.optional(),
});

export const zoneMatrixEntryInputSchema = z.object({
  originRegionId: z.string().uuid(),
  destinationRegionId: z.string().uuid(),
  zone: z.coerce.number().int().min(0).max(99),
});

export const upsertZoneMatrixSchema = z.object({
  entries: z.array(zoneMatrixEntryInputSchema).min(1).max(500),
});

export const listZoneMatrixQuerySchema = z.object({
  originRegionId: z.string().uuid().optional(),
  destinationRegionId: z.string().uuid().optional(),
});

export const tariffRateInputSchema = z
  .object({
    zone: z.coerce.number().int().min(0).max(99),
    weightFromKg: z.coerce.number().min(0),
    weightToKg: z.coerce.number().gt(0),
    price: z.coerce.number().min(0),
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

export const transitLegRateInputSchema = z
  .object({
    sequence: z.coerce.number().int().min(1),
    legCode: z.string().trim().min(1).max(48),
    label: z.string().trim().max(120).optional().nullable(),
    mode: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(z.enum(TARIFF_TRANSPORT_MODES))
      .optional()
      .nullable(),
    originCountryCode: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{2}$/))
      .optional()
      .nullable(),
    destinationCountryCode: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{2}$/))
      .optional()
      .nullable(),
    ratePerKg: z.coerce.number().min(0),
    minCharge: z.coerce.number().min(0).optional().nullable(),
    flatFee: z.coerce.number().min(0).optional().nullable(),
  })
  .superRefine((value, ctx) => {
    if (!value.originCountryCode || !value.destinationCountryCode) {
      ctx.addIssue({
        code: "custom",
        message:
          "originCountryCode and destinationCountryCode are required for each transit leg",
        path: ["originCountryCode"],
      });
    }
  });

export const createTariffPlanSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    code: z.string().trim().max(40).optional().nullable(),
    description: z.string().trim().max(500).optional().nullable(),
    status: z.enum(PRICING_PLAN_STATUSES).default("draft"),
    serviceType: z.enum(SERVICE_TYPES),
    priceType: z.enum(TARIFF_PRICE_TYPES).default("bucket"),
    pricingStrategy: z.enum(TARIFF_PRICING_STRATEGIES).default("FIXED_LANE"),
    coverageType: z.enum(TARIFF_COVERAGE_TYPES).default("domestic"),
    transportMode: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(z.enum(TARIFF_TRANSPORT_MODES))
      .default("ROAD"),
    originCountryCode: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{2}$/))
      .optional()
      .nullable(),
    destinationCountryCode: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{2}$/))
      .optional()
      .nullable(),
    currency: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(z.enum(SUPPORTED_CURRENCY_CODES))
      .default("UZS"),
    priority: z.coerce.number().int().min(0).default(0),
    isDefault: booleanish.optional().default(false),
    customerEntityId: z.string().uuid().optional().nullable(),
    rates: z.array(tariffRateInputSchema).min(0).max(1000),
    transitLegRates: z.array(transitLegRateInputSchema).max(50).optional().default([]),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
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

    if (
      value.coverageType === "domestic" &&
      (value.originCountryCode || value.destinationCountryCode)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "originCountryCode/destinationCountryCode can only be used for international coverageType",
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

    if (
      value.pricingStrategy === "LEG_TRANSIT" &&
      (!value.transitLegRates || value.transitLegRates.length === 0)
    ) {
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
          message:
            "originCountryCode and destinationCountryCode are required for LEG_TRANSIT strategy",
          path: ["originCountryCode"],
        });
        return;
      }

      const sorted = [...value.transitLegRates].sort(
        (a, b) => a.sequence - b.sequence,
      );
      const seenSeq = new Set<number>();
      const seenCodes = new Set<string>();

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
            message:
              "Transit leg sequence must be continuous and start from 1 (1..N)",
            path: ["transitLegRates", index, "sequence"],
          });
        }

        if (index === 0 && leg.originCountryCode !== value.originCountryCode) {
          ctx.addIssue({
            code: "custom",
            message:
              "First transit leg originCountryCode must match tariff originCountryCode",
            path: ["transitLegRates", index, "originCountryCode"],
          });
        }

        if (
          index === sorted.length - 1 &&
          leg.destinationCountryCode !== value.destinationCountryCode
        ) {
          ctx.addIssue({
            code: "custom",
            message:
              "Last transit leg destinationCountryCode must match tariff destinationCountryCode",
            path: ["transitLegRates", index, "destinationCountryCode"],
          });
        }

        if (index > 0) {
          const prev = sorted[index - 1];
          if (prev.destinationCountryCode !== leg.originCountryCode) {
            ctx.addIssue({
              code: "custom",
              message:
                "Transit leg chain is broken: previous destinationCountryCode must equal next originCountryCode",
              path: ["transitLegRates", index, "originCountryCode"],
            });
          }
        }
      }
    }
  });

export const tariffPlanIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const updateTariffPlanSchema = createTariffPlanSchema;

export const listTariffPlansQuerySchema = z.object({
  status: z.enum(PRICING_PLAN_STATUSES).optional(),
  serviceType: z.enum(SERVICE_TYPES).optional(),
  pricingStrategy: z.enum(TARIFF_PRICING_STRATEGIES).optional(),
  coverageType: z.enum(TARIFF_COVERAGE_TYPES).optional(),
  transportMode: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.enum(TARIFF_TRANSPORT_MODES))
    .optional(),
  customerEntityId: z.string().uuid().optional(),
  q: z.string().trim().optional(),
});

export const quoteTariffSchema = z.object({
  customerEntityId: z.string().uuid().optional().nullable(),
  serviceType: z
    .string()
    .optional()
    .nullable()
    .transform((value) => normalizeServiceTypeInput(value))
    .pipe(z.enum(SERVICE_TYPES))
    .default(DEFAULT_SERVICE_TYPE),
  weightKg: z.coerce.number().positive().optional().nullable(),
  originQuery: z.string().trim().optional().nullable(),
  destinationQuery: z.string().trim().optional().nullable(),
  originCountryCode: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .optional()
    .nullable(),
  destinationCountryCode: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .optional()
    .nullable(),
  transportMode: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.enum(TARIFF_TRANSPORT_MODES))
    .optional()
    .nullable(),
});

export const quoteTariffOptionsSchema = quoteTariffSchema.omit({
  transportMode: true,
});

export const createDeliverySlaRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(500).optional().nullable(),
    serviceType: z.enum(SERVICE_TYPES),
    originRegionId: z.string().uuid().optional().nullable(),
    destinationRegionId: z.string().uuid().optional().nullable(),
    zone: z.coerce.number().int().min(0).max(99).optional().nullable(),
    deliveryDays: z.coerce.number().int().min(1).max(365),
    priority: z.coerce.number().int().min(0).default(0),
    isActive: booleanish.optional().default(true),
  })
  .superRefine((value, ctx) => {
    const hasOrigin = Boolean(value.originRegionId);
    const hasDestination = Boolean(value.destinationRegionId);
    const hasZone = value.zone !== null && value.zone !== undefined;

    if (hasOrigin !== hasDestination) {
      ctx.addIssue({
        code: "custom",
        message:
          "originRegionId and destinationRegionId must be provided together",
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

export const updateDeliverySlaRuleSchema = createDeliverySlaRuleSchema;

export const deliverySlaRuleIdParamSchema = z.object({
  id: z.uuid(),
});

export const listDeliverySlaRulesQuerySchema = z.object({
  q: z.string().trim().optional(),
  serviceType: z.enum(SERVICE_TYPES).optional(),
  isActive: booleanish.optional(),
});

export const getOperationalSlaPolicySchema = z.object({});

export const updateOperationalSlaPolicySchema = z.object({
  staleHours: z.coerce.number().int().min(6).max(720),
  dueSoonHours: z.coerce.number().int().min(1).max(168),
  overdueGraceHours: z.coerce.number().int().min(0).max(168),
});

export const backfillOrderSlaSchema = z.object({
  limit: z.coerce.number().int().min(1).max(5000).default(500),
  dryRun: booleanish.optional().default(true),
});

export type CreatePricingRegionInput = z.infer<
  typeof createPricingRegionSchema
>;
export type UpdatePricingRegionInput = z.infer<
  typeof updatePricingRegionSchema
>;
export type UpsertZoneMatrixInput = z.infer<typeof upsertZoneMatrixSchema>;
export type CreateTariffPlanInput = z.infer<typeof createTariffPlanSchema>;
export type UpdateTariffPlanInput = z.infer<typeof updateTariffPlanSchema>;
export type QuoteTariffInput = z.infer<typeof quoteTariffSchema>;
export type QuoteTariffOptionsInput = z.infer<typeof quoteTariffOptionsSchema>;
export type CreateDeliverySlaRuleInput = z.infer<
  typeof createDeliverySlaRuleSchema
>;
export type UpdateDeliverySlaRuleInput = z.infer<
  typeof updateDeliverySlaRuleSchema
>;
export type UpdateOperationalSlaPolicyInput = z.infer<
  typeof updateOperationalSlaPolicySchema
>;
export type BackfillOrderSlaInput = z.infer<typeof backfillOrderSlaSchema>;

export function normalizeTariffCode(value?: string | null) {
  const normalized = normalizeCode(String(value || ""));
  return normalized || null;
}

export function normalizeCountryCode(value?: string | null) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) return null;
  if (/^[A-Z]{2}$/.test(normalized)) return normalized;

  const aliases: Record<string, string> = {
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
