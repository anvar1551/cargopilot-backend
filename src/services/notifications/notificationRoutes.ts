import { Router } from "express";
import { AppRole } from "@prisma/client";

import { auth } from "../../middleware/auth";
import {
  getUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "./notificationController";

const router = Router();

router.get(
  "/",
  auth([AppRole.driver, AppRole.manager]),
  listNotifications,
);

router.get(
  "/unread-count",
  auth([AppRole.driver, AppRole.manager]),
  getUnreadCount,
);

router.post(
  "/:id/read",
  auth([AppRole.driver, AppRole.manager]),
  markNotificationRead,
);

router.post(
  "/read-all",
  auth([AppRole.driver, AppRole.manager]),
  markAllNotificationsRead,
);

export default router;

