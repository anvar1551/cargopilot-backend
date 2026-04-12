import { Router } from "express";
import {
  register,
  login,
  changePassword,
  createByManager,
  listUsersController,
  deleteByManager,
} from "./authController";
import { AppRole } from "@prisma/client";
import { auth } from "../../middleware/auth";

const router = Router();

router.post("/register", register);
router.post("/login", login);
router.post("/change-password", auth(), changePassword);
router.post("/", auth([AppRole.manager]), createByManager);
router.get("/", auth([AppRole.manager]), listUsersController);
router.delete("/:id", auth([AppRole.manager]), deleteByManager);

export default router;
