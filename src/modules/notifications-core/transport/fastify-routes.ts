import { NotificationType } from "@prisma/client";
import { FastifyPluginAsync } from "fastify";

import { emitDriverUnreadCount } from "../../../features/realtime/realtimeHub";
import { fastifyAuth } from "../../../middleware/authFastify";
import { hasPermission } from "../../identity-access";
import { requireOrderActor } from "../../orders-core/shared";
import {
  countUnreadUserNotifications,
  listUserNotifications,
  markAllUserNotificationsRead,
  markUserNotificationRead,
} from "../application/notificationService";

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

async function ensureNotificationsAccess(user?: Express.User | null) {
  if (!user) {
    const err = new Error("Unauthorized") as Error & { statusCode: number };
    err.statusCode = 401;
    throw err;
  }
  const allowed = await hasPermission(user, "drivers.telemetry");
  if (!allowed) {
    const err = new Error("Forbidden") as Error & { statusCode: number };
    err.statusCode = 403;
    throw err;
  }
}

const notificationsFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/", { preHandler: fastifyAuth() }, async (request, reply) => {
    try {
      await ensureNotificationsAccess(request.user);
      const actor = requireOrderActor(request.user);
      const data = await listUserNotifications(actor.id, {
        limit: (request.query as any)?.limit ? Number((request.query as any).limit) : undefined,
        cursor: typeof (request.query as any)?.cursor === "string" ? (request.query as any).cursor : undefined,
        type: parseType((request.query as any)?.type),
        unread: parseUnread((request.query as any)?.unread),
      });
      return reply.send(data);
    } catch (err: any) {
      return reply.code(err?.statusCode ?? 400).send({
        error: err?.message ?? "Failed to list notifications",
      });
    }
  });

  fastify.get("/unread-count", { preHandler: fastifyAuth() }, async (request, reply) => {
    try {
      await ensureNotificationsAccess(request.user);
      const actor = requireOrderActor(request.user);
      const unreadCount = await countUnreadUserNotifications(
        actor.id,
        parseType((request.query as any)?.type),
      );
      return reply.send({ unreadCount });
    } catch (err: any) {
      return reply.code(err?.statusCode ?? 400).send({
        error: err?.message ?? "Failed to get unread count",
      });
    }
  });

  fastify.post("/:id/read", { preHandler: fastifyAuth() }, async (request, reply) => {
    try {
      await ensureNotificationsAccess(request.user);
      const actor = requireOrderActor(request.user);
      const notificationId = String((request.params as any)?.id ?? "").trim();
      if (!notificationId) return reply.code(400).send({ error: "Missing notification id" });

      const result = await markUserNotificationRead(actor.id, notificationId);
      if (!result) return reply.code(404).send({ error: "Notification not found" });

      void emitDriverUnreadCount(actor.id).catch(() => undefined);
      return reply.send({ success: true, id: result.id, readAt: result.readAt });
    } catch (err: any) {
      return reply.code(err?.statusCode ?? 400).send({
        error: err?.message ?? "Failed to mark notification as read",
      });
    }
  });

  fastify.post("/read-all", { preHandler: fastifyAuth() }, async (request, reply) => {
    try {
      await ensureNotificationsAccess(request.user);
      const actor = requireOrderActor(request.user);
      const type = parseType((request.body as any)?.type ?? (request.query as any)?.type);
      const updatedCount = await markAllUserNotificationsRead(actor.id, type);
      void emitDriverUnreadCount(actor.id).catch(() => undefined);
      return reply.send({ success: true, updatedCount });
    } catch (err: any) {
      return reply.code(err?.statusCode ?? 400).send({
        error: err?.message ?? "Failed to mark all notifications as read",
      });
    }
  });
};

export default notificationsFastifyRoutes;

