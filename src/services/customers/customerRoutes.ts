import { Router } from "express";
import { auth } from "../../middleware/auth";
import { list, create, getOne } from "./customerEntityController";
import { AppRole } from "@prisma/client";

const router = Router();

router.get("/", auth([AppRole.manager, AppRole.customer]), list);
router.get("/:id", auth([AppRole.manager, AppRole.customer]), getOne);
router.post("/", auth([AppRole.manager]), create); // keep create manager-only

export default router;
