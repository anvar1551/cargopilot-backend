import { Router } from "express";
import { auth } from "../../middleware/auth";
import { list } from "./customerEntityController";
import { AppRole } from "@prisma/client";

const router = Router();

// only manager and customer can see customer entities
router.get("/", auth([AppRole.manager, AppRole.customer]), list);

export default router;
