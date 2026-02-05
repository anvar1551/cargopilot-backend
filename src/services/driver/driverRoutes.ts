import { Router } from "express";
import { auth } from "../../middleware/auth";
import { AppRole } from "@prisma/client";
import { assignDriver, listDrivers } from "./driverController";

const router = Router();

router.patch("/assign", auth([AppRole.manager]), assignDriver);

router.get("/", auth([AppRole.manager]), listDrivers);

export default router;
