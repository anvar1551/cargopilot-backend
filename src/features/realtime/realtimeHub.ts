import { randomUUID } from "crypto";
import type { Server as HttpServer } from "http";
import jwt from "jsonwebtoken";
import { AppRole, NotificationType } from "@prisma/client";
import { Server, Socket } from "socket.io";

import prisma from "../../config/prismaClient";
import { countUnreadUserNotifications, createUserNotification } from "../../services/notifications/notificationService";

type AuthSocket = Socket & {
  data: {
    user?: {
      id: string;
      role: AppRole;
      warehouseId?: string | null;
    };
  };
};

type JwtPayload = { id: string };

export type DriverRealtimeNotification = {
  id: string;
  type: "order" | "cash" | "system";
  title: string;
  body: string;
  at: string;
  orderId?: string | null;
};

type DriverOrderRealtimeUpdate = {
  orderId: string;
  orderNumber?: string | null;
  status: string;
  updatedAt: string;
};

let io: Server | null = null;

function toAllowedOriginMatcher(origins: string[]) {
  const cleaned = origins
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  return (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) return callback(null, true);
    if (cleaned.length === 0) return callback(null, true);
    if (cleaned.includes(origin)) return callback(null, true);
    return callback(new Error("Origin not allowed by Socket.IO CORS"));
  };
}

function parseSocketToken(socket: Socket) {
  const fromAuth = String((socket.handshake.auth as any)?.token ?? "").trim();
  if (fromAuth) return fromAuth;

  const header = String(socket.handshake.headers.authorization ?? "").trim();
  if (header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  return "";
}

function userRoom(userId: string) {
  return `user:${userId}`;
}

export function initRealtimeHub(server: HttpServer, corsOrigins: string[]) {
  if (io) return io;

  io = new Server(server, {
    cors: {
      origin: toAllowedOriginMatcher(corsOrigins),
      credentials: true,
      methods: ["GET", "POST"],
    },
    transports: ["websocket", "polling"],
  });

  io.use(async (socket, next) => {
    try {
      const token = parseSocketToken(socket);
      if (!token) return next(new Error("Unauthorized"));

      const secret = process.env.JWT_SECRET;
      if (!secret) return next(new Error("JWT_SECRET not configured"));

      const decoded = jwt.verify(token, secret) as JwtPayload;
      const user = await prisma.user.findUnique({
        where: { id: decoded.id },
        select: {
          id: true,
          role: true,
          warehouseId: true,
        },
      });
      if (!user) return next(new Error("Unauthorized"));

      const authSocket = socket as AuthSocket;
      authSocket.data.user = {
        id: user.id,
        role: user.role,
        warehouseId: user.warehouseId ?? null,
      };
      return next();
    } catch {
      return next(new Error("Unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const authSocket = socket as AuthSocket;
    const user = authSocket.data.user;
    if (!user) {
      socket.disconnect(true);
      return;
    }

    socket.join(userRoom(user.id));
    socket.join(`role:${user.role}`);
    if (user.warehouseId) {
      socket.join(`warehouse:${user.warehouseId}`);
    }

    socket.emit("driver:realtime:ready", {
      connectedAt: new Date().toISOString(),
      userId: user.id,
    });
  });

  return io;
}

function getIo() {
  return io;
}

export async function emitDriverNotification(
  userId: string,
  payload: Omit<DriverRealtimeNotification, "id" | "at"> & Partial<Pick<DriverRealtimeNotification, "id" | "at">>,
) {
  const cleanUserId = String(userId ?? "").trim();
  if (!cleanUserId) return;

  const cleanTitle = String(payload.title ?? "").trim();
  const cleanBody = String(payload.body ?? "").trim();
  if (!cleanTitle || !cleanBody) return;

  const notificationType =
    payload.type === "order" || payload.type === "cash" || payload.type === "system"
      ? payload.type
      : "system";

  const created = await createUserNotification({
    userId: cleanUserId,
    type: notificationType as NotificationType,
    title: cleanTitle,
    body: cleanBody,
    orderId: payload.orderId ?? null,
    data: null,
  });

  const event: DriverRealtimeNotification = {
    id: created.id || payload.id || randomUUID(),
    type: notificationType,
    title: created.title,
    body: created.body,
    at: created.createdAt.toISOString(),
    orderId: created.orderId ?? payload.orderId ?? null,
  };

  const server = getIo();
  if (!server) return;
  server.to(userRoom(userId)).emit("driver:notification", event);

  const unreadCount = await countUnreadUserNotifications(cleanUserId);
  server.to(userRoom(userId)).emit("driver:notifications:unread-count", {
    unreadCount,
    at: new Date().toISOString(),
  });
}

export function emitDriverOrderUpdate(userId: string, payload: DriverOrderRealtimeUpdate) {
  const server = getIo();
  if (!server || !userId) return;
  server.to(userRoom(userId)).emit("driver:order-updated", payload);
}

export async function emitDriverUnreadCount(userId: string) {
  const server = getIo();
  if (!server || !userId) return;
  const unreadCount = await countUnreadUserNotifications(userId);
  server.to(userRoom(userId)).emit("driver:notifications:unread-count", {
    unreadCount,
    at: new Date().toISOString(),
  });
}
