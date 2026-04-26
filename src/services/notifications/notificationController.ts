import { AppRole, NotificationType } from "@prisma/client";
import { emitDriverUnreadCount } from "../../features/realtime/realtimeHub";

import { requireOrderActor } from "../orders/orderService.shared";
import {
  countUnreadUserNotifications,
  listUserNotifications,
  markAllUserNotificationsRead,
  markUserNotificationRead,
} from "./notificationService";

function parseType(value: unknown): NotificationType | null {
  if (value === NotificationType.order) return NotificationType.order;
  if (value === NotificationType.cash) return NotificationType.cash;
  if (value === NotificationType.system) return NotificationType.system;
  return null;
}

function parseUnread(value: unknown): boolean | null {
  if (value === true || value === "true" || value === "1" || value === 1) return true;
  if (value === false || value === "false" || value === "0" || value === 0) return false;
  return null;
}

function assertDriverOrManager(role: AppRole) {
  if (role === AppRole.driver || role === AppRole.manager) return;
  throw new Error("Forbidden");
}

/** Returns notifications with cursor pagination and optional type/unread filters. */
export async function listNotifications(req: any, res: any) {
  try {
    const actor = requireOrderActor(req.user);
    assertDriverOrManager(actor.role);

    const data = await listUserNotifications(actor.id, {
      limit: req.query?.limit ? Number(req.query.limit) : undefined,
      cursor: typeof req.query?.cursor === "string" ? req.query.cursor : undefined,
      type: parseType(req.query?.type),
      unread: parseUnread(req.query?.unread),
    });

    return res.json(data);
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? "Failed to list notifications" });
  }
}

/** Returns unread notification count (optionally filtered by type). */
export async function getUnreadCount(req: any, res: any) {
  try {
    const actor = requireOrderActor(req.user);
    assertDriverOrManager(actor.role);

    const unreadCount = await countUnreadUserNotifications(
      actor.id,
      parseType(req.query?.type),
    );
    return res.json({ unreadCount });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? "Failed to get unread count" });
  }
}

/** Marks one notification as read for current user. */
export async function markNotificationRead(req: any, res: any) {
  try {
    const actor = requireOrderActor(req.user);
    assertDriverOrManager(actor.role);

    const notificationId = String(req.params?.id ?? "").trim();
    if (!notificationId) return res.status(400).json({ error: "Missing notification id" });

    const result = await markUserNotificationRead(actor.id, notificationId);
    if (!result) return res.status(404).json({ error: "Notification not found" });

    void emitDriverUnreadCount(actor.id).catch(() => undefined);

    return res.json({ success: true, id: result.id, readAt: result.readAt });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? "Failed to mark notification as read" });
  }
}

/** Marks all matching notifications as read for current user. */
export async function markAllNotificationsRead(req: any, res: any) {
  try {
    const actor = requireOrderActor(req.user);
    assertDriverOrManager(actor.role);

    const type = parseType(req.body?.type ?? req.query?.type);
    const updatedCount = await markAllUserNotificationsRead(actor.id, type);
    void emitDriverUnreadCount(actor.id).catch(() => undefined);
    return res.json({ success: true, updatedCount });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? "Failed to mark all notifications as read" });
  }
}
