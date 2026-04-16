import { Router } from "express";
import { AppRole } from "@prisma/client";
import { auth } from "../../middleware/auth";
import {
  createPlan,
  createRegion,
  getPlan,
  getPlans,
  getRegions,
  getZoneMatrix,
  quotePlan,
  saveZoneMatrix,
  updatePlan,
  updateRegion,
} from "./pricingController";

const router = Router();

router.get("/regions", auth([AppRole.manager, AppRole.customer]), getRegions);
router.post("/regions", auth([AppRole.manager]), createRegion);
router.put("/regions/:id", auth([AppRole.manager]), updateRegion);

router.get("/zones", auth([AppRole.manager]), getZoneMatrix);
router.post("/zones/bulk", auth([AppRole.manager]), saveZoneMatrix);

router.get("/tariff-plans", auth([AppRole.manager]), getPlans);
router.get("/tariff-plans/:id", auth([AppRole.manager]), getPlan);
router.post("/tariff-plans", auth([AppRole.manager]), createPlan);
router.put("/tariff-plans/:id", auth([AppRole.manager]), updatePlan);
router.post("/quote", auth([AppRole.manager, AppRole.customer]), quotePlan);

export default router;
