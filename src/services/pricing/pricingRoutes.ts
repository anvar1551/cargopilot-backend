import { Router } from "express";
import { AppRole } from "@prisma/client";
import { auth } from "../../middleware/auth";
import {
  createPlan,
  createRegion,
  createSlaRule,
  getSlaPolicy,
  getPlan,
  getPlans,
  getRegions,
  getSlaRules,
  getZoneMatrix,
  quotePlan,
  runSlaBackfill,
  saveZoneMatrix,
  updatePlan,
  updateRegion,
  updateSlaPolicy,
  updateSlaRule,
} from "./pricingController";

const router = Router();

router.get("/regions", auth([AppRole.manager, AppRole.customer]), getRegions);
router.post("/regions", auth([AppRole.manager]), createRegion);
router.put("/regions/:id", auth([AppRole.manager]), updateRegion);
router.get("/sla-rules", auth([AppRole.manager]), getSlaRules);
router.post("/sla-rules", auth([AppRole.manager]), createSlaRule);
router.put("/sla-rules/:id", auth([AppRole.manager]), updateSlaRule);
router.get("/sla-policy", auth([AppRole.manager]), getSlaPolicy);
router.put("/sla-policy", auth([AppRole.manager]), updateSlaPolicy);
router.post("/sla/backfill", auth([AppRole.manager]), runSlaBackfill);

router.get("/zones", auth([AppRole.manager]), getZoneMatrix);
router.post("/zones/bulk", auth([AppRole.manager]), saveZoneMatrix);

router.get("/tariff-plans", auth([AppRole.manager]), getPlans);
router.get("/tariff-plans/:id", auth([AppRole.manager]), getPlan);
router.post("/tariff-plans", auth([AppRole.manager]), createPlan);
router.put("/tariff-plans/:id", auth([AppRole.manager]), updatePlan);
router.post("/quote", auth([AppRole.manager, AppRole.customer]), quotePlan);

export default router;
