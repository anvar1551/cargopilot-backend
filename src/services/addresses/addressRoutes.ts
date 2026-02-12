import { Router } from "express";
import { list } from "./addressController";
import { auth } from "../../middleware/auth";
import { AppRole } from "@prisma/client";

const router = Router();

router.get("/", auth([AppRole.manager, AppRole.customer]), list);

export default router;
