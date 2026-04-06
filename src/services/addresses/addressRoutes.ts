import { Router } from "express";
import { list, create } from "./addressController";
import { auth } from "../../middleware/auth";
import { AppRole } from "@prisma/client";

const router = Router();

router.get("/", auth([AppRole.manager, AppRole.customer]), list);
router.post("/", auth([AppRole.manager, AppRole.customer]), create);

export default router;
