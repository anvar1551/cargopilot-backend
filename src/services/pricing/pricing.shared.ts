import { z } from "zod";
import {
  DEFAULT_SERVICE_TYPE,
  SERVICE_TYPES,
  normalizeServiceTypeInput,
} from "../orders/order.constants";

export const PRICING_PLAN_STATUSES = ["draft", "active", "archived"] as const;
export const TARIFF_PRICE_TYPES = ["bucket", "linear"] as const;

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

export const createTariffPlanSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    code: z.string().trim().max(40).optional().nullable(),
    description: z.string().trim().max(500).optional().nullable(),
    status: z.enum(PRICING_PLAN_STATUSES).default("draft"),
    serviceType: z.enum(SERVICE_TYPES),
    priceType: z.enum(TARIFF_PRICE_TYPES).default("bucket"),
    currency: z.string().trim().min(3).max(8).default("UZS"),
    priority: z.coerce.number().int().min(0).default(0),
    isDefault: booleanish.optional().default(false),
    customerEntityId: z.string().uuid().optional().nullable(),
    rates: z.array(tariffRateInputSchema).min(1).max(1000),
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
  });

export const tariffPlanIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const updateTariffPlanSchema = createTariffPlanSchema;

export const listTariffPlansQuerySchema = z.object({
  status: z.enum(PRICING_PLAN_STATUSES).optional(),
  serviceType: z.enum(SERVICE_TYPES).optional(),
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
