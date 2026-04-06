import { Router } from "express";
import {
  register,
  login,
  createByManager,
  listUsersController,
} from "./authController";
import { AppRole } from "@prisma/client";
import { auth } from "../../middleware/auth";

const router = Router();

router.post("/register", register);
router.post("/login", login);
router.post("/", auth([AppRole.manager]), createByManager);
router.get("/", auth([AppRole.manager]), listUsersController);

export default router;
