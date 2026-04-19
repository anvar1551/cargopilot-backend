import { Request, Response } from "express";
import { ZodError } from "zod";
import {
  backfillOrderSlaSnapshots,
  createDeliverySlaRule,
  createPricingRegion,
  createTariffPlan,
  getOperationalSlaPolicy,
  getTariffPlanById,
  listDeliverySlaRules,
  listPricingRegions,
  listTariffPlans,
  listZoneMatrix,
  quoteTariff,
  updateDeliverySlaRule,
  updateOperationalSlaPolicy,
  updatePricingRegion,
  updateTariffPlan,
  upsertZoneMatrix,
} from "./pricingRepo";
import {
  backfillOrderSlaSchema,
  createDeliverySlaRuleSchema,
  createPricingRegionSchema,
  createTariffPlanSchema,
  deliverySlaRuleIdParamSchema,
  listDeliverySlaRulesQuerySchema,
  listPricingRegionsQuerySchema,
  listTariffPlansQuerySchema,
  listZoneMatrixQuerySchema,
  pricingRegionIdParamSchema,
  quoteTariffSchema,
  tariffPlanIdParamSchema,
  updateOperationalSlaPolicySchema,
  updateDeliverySlaRuleSchema,
  updatePricingRegionSchema,
  updateTariffPlanSchema,
  upsertZoneMatrixSchema,
} from "./pricing.shared";

function sendError(res: Response, error: unknown, fallback: string) {
  if (error instanceof ZodError) {
    return res.status(400).json({
      error: "Validation failed",
      issues: error.flatten(),
    });
  }

  const candidate = error as { status?: number; message?: string };
  return res
    .status(candidate?.status ?? 500)
    .json({ error: candidate?.message ?? fallback });
}

export async function createRegion(req: Request, res: Response) {
  try {
    const input = createPricingRegionSchema.parse(req.body);
    const region = await createPricingRegion(input);
    return res.status(201).json(region);
  } catch (error) {
    console.error("createRegion error:", error);
    return sendError(res, error, "Failed to create pricing region");
  }
}

export async function getRegions(req: Request, res: Response) {
  try {
    const query = listPricingRegionsQuerySchema.parse(req.query);
    const effectiveQuery =
      req.user?.role === "customer"
        ? {
            ...query,
            isActive: true,
          }
        : query;
    const regions = await listPricingRegions(effectiveQuery);
    return res.json(regions);
  } catch (error) {
    console.error("getRegions error:", error);
    return sendError(res, error, "Failed to fetch pricing regions");
  }
}

export async function updateRegion(req: Request, res: Response) {
  try {
    const { id } = pricingRegionIdParamSchema.parse(req.params);
    const input = updatePricingRegionSchema.parse(req.body);
    const region = await updatePricingRegion(id, input);
    return res.json(region);
  } catch (error) {
    console.error("updateRegion error:", error);
    return sendError(res, error, "Failed to update pricing region");
  }
}

export async function createSlaRule(req: Request, res: Response) {
  try {
    const input = createDeliverySlaRuleSchema.parse(req.body);
    const rule = await createDeliverySlaRule(input);
    return res.status(201).json(rule);
  } catch (error) {
    console.error("createSlaRule error:", error);
    return sendError(res, error, "Failed to create delivery SLA rule");
  }
}

export async function getSlaRules(req: Request, res: Response) {
  try {
    const query = listDeliverySlaRulesQuerySchema.parse(req.query);
    const rules = await listDeliverySlaRules(query);
    return res.json(rules);
  } catch (error) {
    console.error("getSlaRules error:", error);
    return sendError(res, error, "Failed to fetch delivery SLA rules");
  }
}

export async function updateSlaRule(req: Request, res: Response) {
  try {
    const { id } = deliverySlaRuleIdParamSchema.parse(req.params);
    const input = updateDeliverySlaRuleSchema.parse(req.body);
    const rule = await updateDeliverySlaRule(id, input);
    return res.json(rule);
  } catch (error) {
    console.error("updateSlaRule error:", error);
    return sendError(res, error, "Failed to update delivery SLA rule");
  }
}

export async function getSlaPolicy(req: Request, res: Response) {
  try {
    const policy = await getOperationalSlaPolicy();
    return res.json(policy);
  } catch (error) {
    console.error("getSlaPolicy error:", error);
    return sendError(res, error, "Failed to fetch operational SLA policy");
  }
}

export async function updateSlaPolicy(req: Request, res: Response) {
  try {
    const input = updateOperationalSlaPolicySchema.parse(req.body);
    const policy = await updateOperationalSlaPolicy(input);
    return res.json(policy);
  } catch (error) {
    console.error("updateSlaPolicy error:", error);
    return sendError(res, error, "Failed to update operational SLA policy");
  }
}

export async function runSlaBackfill(req: Request, res: Response) {
  try {
    const input = backfillOrderSlaSchema.parse(req.body ?? {});
    const result = await backfillOrderSlaSnapshots(input);
    return res.json(result);
  } catch (error) {
    console.error("runSlaBackfill error:", error);
    return sendError(res, error, "Failed to run SLA backfill");
  }
}

export async function saveZoneMatrix(req: Request, res: Response) {
  try {
    const input = upsertZoneMatrixSchema.parse(req.body);
    const zones = await upsertZoneMatrix(input);
    return res.status(201).json(zones);
  } catch (error) {
    console.error("saveZoneMatrix error:", error);
    return sendError(res, error, "Failed to save zone matrix");
  }
}

export async function getZoneMatrix(req: Request, res: Response) {
  try {
    const query = listZoneMatrixQuerySchema.parse(req.query);
    const zones = await listZoneMatrix(query);
    return res.json(zones);
  } catch (error) {
    console.error("getZoneMatrix error:", error);
    return sendError(res, error, "Failed to fetch zone matrix");
  }
}

export async function createPlan(req: Request, res: Response) {
  try {
    const input = createTariffPlanSchema.parse(req.body);
    const plan = await createTariffPlan(input);
    return res.status(201).json(plan);
  } catch (error) {
    console.error("createPlan error:", error);
    return sendError(res, error, "Failed to create tariff plan");
  }
}

export async function getPlans(req: Request, res: Response) {
  try {
    const query = listTariffPlansQuerySchema.parse(req.query);
    const plans = await listTariffPlans(query);
    return res.json(plans);
  } catch (error) {
    console.error("getPlans error:", error);
    return sendError(res, error, "Failed to fetch tariff plans");
  }
}

export async function getPlan(req: Request, res: Response) {
  try {
    const { id } = tariffPlanIdParamSchema.parse(req.params);
    const plan = await getTariffPlanById(id);

    if (!plan) {
      return res.status(404).json({ error: "Tariff plan not found" });
    }

    return res.json(plan);
  } catch (error) {
    console.error("getPlan error:", error);
    return sendError(res, error, "Failed to fetch tariff plan");
  }
}

export async function updatePlan(req: Request, res: Response) {
  try {
    const { id } = tariffPlanIdParamSchema.parse(req.params);
    const input = updateTariffPlanSchema.parse(req.body);
    const plan = await updateTariffPlan(id, input);
    return res.json(plan);
  } catch (error) {
    console.error("updatePlan error:", error);
    return sendError(res, error, "Failed to update tariff plan");
  }
}

export async function quotePlan(req: Request, res: Response) {
  try {
    const parsed = quoteTariffSchema.parse(req.body);
    const input =
      req.user?.role === "customer"
        ? {
            ...parsed,
            customerEntityId: req.user.customerEntityId ?? null,
          }
        : parsed;
    const quote = await quoteTariff(input);
    return res.json(quote);
  } catch (error) {
    console.error("quotePlan error:", error);
    return sendError(res, error, "Failed to quote tariff plan");
  }
}
