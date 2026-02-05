import { Router } from "express";
import { getManagerOverview } from "./analyticsController";
import { auth } from "../../middleware/auth";

const router = Router();

// Manager-only route
router.get("/overview", auth(["manager"]), getManagerOverview);

export default router;
