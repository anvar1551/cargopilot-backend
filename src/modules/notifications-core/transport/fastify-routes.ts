import { NotificationType } from "@prisma/client";
import { FastifyPluginAsync } from "fastify";

import { emitDriverUnreadCount } from "../../../modules/realtime-core/realtimeHub";
import { fastifyAuth } from "../../../modules/identity-access/transport/fastify-auth";
import {
  countUnreadUserNotifications,
  getUserNotification,
  listUserNotifications,
  markAllUserNotificationsRead,
  markUserNotificationRead,
  NotificationAccessContext,
} from "../application/notificationService";

function parseType(value: unknown): NotificationType | null {
  if (value === NotificationType.order) return NotificationType.order;
  if (value === NotificationType.cash) return NotificationType.cash;
  if (value === NotificationType.support) return NotificationType.support;
  if (value === NotificationType.system) return NotificationType.system;
  return null;
}

function parseUnread(value: unknown): boolean | null {
  if (value === true || value === "true" || value === "1" || value === 1) return true;
  if (value === false || value === "false" || value === "0" || value === 0) return false;
  return null;
}

const notificationsFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/", { preHandler: fastifyAuth() }, async (request, reply) => {
    try {
      const context = request.user as NotificationAccessContext;
      const data = await listUserNotifications(context, {
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
      const context = request.user as NotificationAccessContext;
      const unreadCount = await countUnreadUserNotifications(
        context,
        parseType((request.query as any)?.type),
      );
      return reply.send({ unreadCount });
    } catch (err: any) {
      return reply.code(err?.statusCode ?? 400).send({
        error: err?.message ?? "Failed to get unread count",
      });
    }
  });

  fastify.get("/:id", { preHandler: fastifyAuth() }, async (request, reply) => {
    try {
      const notificationId = String((request.params as any)?.id ?? "").trim();
      if (!notificationId) return reply.code(400).send({ error: "Missing notification id" });
      const result = await getUserNotification(request.user as NotificationAccessContext, notificationId);
      if (!result) return reply.code(404).send({ error: "Notification not found" });
      return reply.send(result);
    } catch (err: any) {
      return reply.code(err?.statusCode ?? 400).send({
        error: err?.message ?? "Failed to get notification",
      });
    }
  });

  fastify.post("/:id/read", { preHandler: fastifyAuth() }, async (request, reply) => {
    try {
      const context = request.user as NotificationAccessContext;
      const notificationId = String((request.params as any)?.id ?? "").trim();
      if (!notificationId) return reply.code(400).send({ error: "Missing notification id" });

      const result = await markUserNotificationRead(context, notificationId);
      if (!result) return reply.code(404).send({ error: "Notification not found" });

      void emitDriverUnreadCount(context).catch(() => undefined);
      return reply.send({ success: true, id: result.id, readAt: result.readAt });
    } catch (err: any) {
      return reply.code(err?.statusCode ?? 400).send({
        error: err?.message ?? "Failed to mark notification as read",
      });
    }
  });

  fastify.post("/read-all", { preHandler: fastifyAuth() }, async (request, reply) => {
    try {
      const context = request.user as NotificationAccessContext;
      const type = parseType((request.body as any)?.type ?? (request.query as any)?.type);
      const updatedCount = await markAllUserNotificationsRead(context, type);
      void emitDriverUnreadCount(context).catch(() => undefined);
      return reply.send({ success: true, updatedCount });
    } catch (err: any) {
      return reply.code(err?.statusCode ?? 400).send({
        error: err?.message ?? "Failed to mark all notifications as read",
      });
    }
  });
};

export default notificationsFastifyRoutes;
