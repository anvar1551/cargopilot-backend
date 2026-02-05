import { Router } from "express";
import { auth } from "../../middleware/auth";
import { getManagerOverview } from "./managerController";
import { listDrivers } from "./managerController";

const router = Router();

router.get("/overview", auth(["manager"]), getManagerOverview);
router.get("/drivers", auth(["manager"]), listDrivers);

export default router;
