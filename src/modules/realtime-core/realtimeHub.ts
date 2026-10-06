import { requireAcceptedDriver } from "../identity-access/application/driver-eligibility";
import type { Server as HttpServer } from "http";
import jwt from "jsonwebtoken";
import { Server, Socket } from "socket.io";

import prisma from "../../config/prismaClient";
import { loadAccessSnapshot } from "../../modules/identity-access/access-control";
import type { AccessTokenPayload } from "../../modules/identity-access/types";
import { hasLiveAccessSession, isBoundAccessSession } from "../identity-access/application/access-session";
import {
  countUnreadUserNotifications,
  type NotificationAccessContext,
} from "../../modules/notifications-core/application/notificationService";

type AuthSocket = Socket & {
  data: {
    user?: {
      id: string;
      tenantId: string;
      tenantMembershipId: string;
      companyId: string;
      companyMembershipId: string;
      sid: string;
      expiresAt: number;
      audience: string;
      warehouseId?: string | null;
    };
  };
};

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
let pendingSocketAdmissions = 0;
const MAX_PROCESS_SOCKETS = 1024;
const SWEEP_BATCH = 64;
const CHECK_CONCURRENCY = 4;

async function revalidateSocket(socket: AuthSocket, permission?: string) {
  const u = socket.data.user;
  if (!u) return false;
  const claims = { ...u, membershipId: u.companyMembershipId, exp: u.expiresAt, tokenType: "access" as const };
  if (!isBoundAccessSession(claims)) return false;
  const snapshot = await loadAccessSnapshot({ userId: u.id, membershipId: u.companyMembershipId,
    companyMembershipId: u.companyMembershipId, companyId: u.companyId, tenantId: u.tenantId,
    tenantMembershipId: u.tenantMembershipId, requireFresh: true });
  return !!snapshot && (!permission || snapshot.permissionCodes.includes(permission)) && await hasLiveAccessSession(claims);
}

async function checkedSocketWork(sockets: AuthSocket[], work: (socket: AuthSocket) => Promise<void>) {
  for (let offset = 0; offset < sockets.length; offset += CHECK_CONCURRENCY) {
    await Promise.all(sockets.slice(offset, offset + CHECK_CONCURRENCY).map(work));
  }
}

async function emitToLiveRecipients(server: Server, context: RealtimeRecipientContext, event: string, payload: unknown, permission?: string) {
  const sockets: AuthSocket[] = [];
  for (const socket of server.sockets.sockets.values()) {
    const s = socket as AuthSocket, u = s.data.user;
    if (u?.id === context.userId && u.tenantId === context.tenantId && u.companyId === context.companyId &&
        u.companyMembershipId === context.companyMembershipId && u.tenantMembershipId === context.tenantMembershipId) sockets.push(s);
  }
  if (sockets.length > MAX_PROCESS_SOCKETS) {
    recordSuppressedDelivery(event, "recipient_capacity_exceeded"); return;
  }
  await checkedSocketWork(sockets, async socket => {
    try {
      if (await revalidateSocket(socket, permission) && socket.connected !== false &&
          (socket.data.user?.expiresAt ?? 0) * 1000 > Date.now()) { socket.emit(event, payload); return; }
    } catch { /* Deny on database failure; no cached-authority fallback. */ }
    recordSuppressedDelivery(event, "recipient_session_ineligible"); socket.disconnect(true);
  });
}

function startSessionSweep(server: Server) {
  let checking = false, pending: AuthSocket[] = [];
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      // Finite cycle: connection churn cannot indefinitely postpone older sockets.
      if (!pending.length) pending = Array.from(server.sockets.sockets.values()).slice(0, MAX_PROCESS_SOCKETS) as AuthSocket[];
      const batch = pending.splice(0, SWEEP_BATCH);
      await checkedSocketWork(batch, async socket => {
        try { if (socket.connected !== false && await revalidateSocket(socket)) return; } catch { /* fail closed */ }
        socket.disconnect(true);
      });
    } finally { checking = false; }
  }, 5000);
  timer.unref();
  server.engine.on("close", () => clearInterval(timer));
}

function deriveProfileType(args: {
  warehouseId?: string | null;
  customerEntityId?: string | null;
  roleCodes: string[];
  permissionCodes: string[];
}): string {
  const roleCodes = new Set(args.roleCodes.map((value) => value.toLowerCase()).filter(Boolean));
  const permissionCodes = new Set(args.permissionCodes.filter(Boolean));

  if (permissionCodes.has("drivers.telemetry") || Array.from(roleCodes).some((c) => c.includes("driver"))) {
    return "driver";
  }
  if (
    args.warehouseId ||
    permissionCodes.has("warehouses.read") ||
    Array.from(roleCodes).some((c) => c.includes("warehouse") || c.includes("pvz") || c.includes("branch"))
  ) {
    return "warehouse";
  }
  if (
    args.customerEntityId ||
    permissionCodes.has("payments.intents.read") ||
    Array.from(roleCodes).some((c) => c.includes("customer") || c.includes("client"))
  ) {
    return "customer";
  }
  return "manager";
}

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

type RealtimeRecipientContext = {
  userId: string;
  tenantId: string;
  tenantMembershipId: string;
  companyId: string;
  companyMembershipId: string;
};

function recipientRoom(context: Pick<RealtimeRecipientContext,
  "userId" | "tenantId" | "companyId" | "companyMembershipId">) {
  return [
    "tenant", context.tenantId,
    "company-membership", context.companyMembershipId,
    "company", context.companyId,
    "user", context.userId,
  ].join(":");
}

const realtimeDiagnosticLastLoggedAt = new Map<string, number>();
const REALTIME_DIAGNOSTIC_INTERVAL_MS = 60_000;

function recordSuppressedDelivery(eventType: string, reason: string) {
  const key = `${eventType}:${reason}`;
  const now = Date.now();
  const lastLoggedAt = realtimeDiagnosticLastLoggedAt.get(key) ?? 0;
  if (now - lastLoggedAt < REALTIME_DIAGNOSTIC_INTERVAL_MS) return;
  realtimeDiagnosticLastLoggedAt.set(key, now);
  console.warn("[realtime-security] protected delivery suppressed", { eventType, reason });
}

function disconnectRecipientSockets(server: Server, expected: {
  userId: string;
  tenantId: string;
  companyId: string;
}) {
  for (const socket of server.sockets.sockets.values()) {
    const context = (socket as AuthSocket).data.user;
    if (context?.id === expected.userId
      && context.tenantId === expected.tenantId
      && context.companyId === expected.companyId) {
      socket.disconnect(true);
    }
  }
}

async function resolveOrderRecipientContext(args: {
  eventType: string;
  orderId: string;
  userId: string;
}): Promise<RealtimeRecipientContext | null> {
  const orderId = String(args.orderId ?? "").trim();
  const userId = String(args.userId ?? "").trim();
  if (!orderId || !userId) {
    recordSuppressedDelivery(args.eventType, "missing_recipient_or_order");
    return null;
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, tenantId: true, ownerOrgId: true, assignedDriverId: true },
  });
  if (!order?.tenantId || !order.ownerOrgId) {
    recordSuppressedDelivery(args.eventType, "missing_authoritative_order_ownership");
    return null;
  }
  if (order.assignedDriverId !== userId) {
    recordSuppressedDelivery(args.eventType, "recipient_not_assigned_to_order");
    return null;
  }

  const membership = await prisma.companyMembership.findUnique({
    where: { userId_companyId: { userId, companyId: order.ownerOrgId } },
    select: { id: true, tenantId: true, tenantMembershipId: true },
  });
  const server = getIo();
  if (!membership?.id || !membership.tenantId || !membership.tenantMembershipId) {
    recordSuppressedDelivery(args.eventType, "missing_recipient_membership_context");
    if (server) {
      disconnectRecipientSockets(server, {
        userId,
        tenantId: order.tenantId,
        companyId: order.ownerOrgId,
      });
    }
    return null;
  }

  const snapshot = await loadAccessSnapshot({
    userId,
    membershipId: membership.id,
    companyMembershipId: membership.id,
    companyId: order.ownerOrgId,
    tenantId: order.tenantId,
    tenantMembershipId: membership.tenantMembershipId,
    requireFresh: true,
  });
  let eligible = false;
  try { await requireAcceptedDriver(prisma, { tenantId: order.tenantId, companyId: order.ownerOrgId }, membership.id, undefined, "drivers.telemetry"); eligible = true; }
  catch (error) { if ((error as {statusCode?:number}).statusCode !== 403) throw error; }
  if (!eligible || !snapshot || !snapshot.permissionCodes.includes("drivers.telemetry")) {
    recordSuppressedDelivery(args.eventType, snapshot ? "recipient_permission_removed" : "recipient_context_ineligible");
    if (server) {
      disconnectRecipientSockets(server, {
        userId,
        tenantId: order.tenantId,
        companyId: order.ownerOrgId,
      });
    }
    return null;
  }

  return {
    userId,
    tenantId: snapshot.tenantId,
    tenantMembershipId: snapshot.tenantMembershipId,
    companyId: snapshot.companyId,
    companyMembershipId: snapshot.companyMembershipId,
  };
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
    if (io!.sockets.sockets.size + pendingSocketAdmissions >= MAX_PROCESS_SOCKETS) return next(new Error("Unauthorized"));
    pendingSocketAdmissions++;
    try {
      const token = parseSocketToken(socket);
      if (!token) return next(new Error("Unauthorized"));

      const secret = process.env.JWT_SECRET;
      if (!secret) return next(new Error("JWT_SECRET not configured"));

      const decoded = jwt.verify(token, secret) as AccessTokenPayload;
      if (!isBoundAccessSession(decoded) || !await hasLiveAccessSession(decoded)) {
        return next(new Error("Unauthorized"));
      }
      const user = await loadAccessSnapshot({
        userId: decoded.id,
        membershipId: decoded.membershipId,
        companyMembershipId: decoded.companyMembershipId,
        companyId: decoded.companyId,
        tenantId: decoded.tenantId,
        tenantMembershipId: decoded.tenantMembershipId,
        requireFresh: true,
      });
      if (!user) return next(new Error("Unauthorized"));

      const audience = deriveProfileType({
        warehouseId: user.warehouseId ?? null,
        customerEntityId: user.customerEntityId ?? null,
        roleCodes: user.roleCodes,
        permissionCodes: user.permissionCodes,
      });

      const authSocket = socket as AuthSocket;
      authSocket.data.user = {
        id: user.userId,
        tenantId: user.tenantId,
        tenantMembershipId: user.tenantMembershipId,
        companyId: user.companyId,
        companyMembershipId: user.companyMembershipId,
        sid: decoded.sid,
        expiresAt: decoded.exp,
        audience,
        warehouseId: user.warehouseId ?? null,
      };
      return next();
    } catch {
      return next(new Error("Unauthorized"));
    } finally {
      pendingSocketAdmissions--;
    }
  });

  io.on("connection", (socket) => {
    const authSocket = socket as AuthSocket;
    const user = authSocket.data.user;
    if (!user) {
      socket.disconnect(true);
      return;
    }

    const selectedContextRoom = recipientRoom({
      userId: user.id,
      tenantId: user.tenantId,
      companyId: user.companyId,
      companyMembershipId: user.companyMembershipId,
    });
    socket.join(selectedContextRoom);
    socket.join(`${selectedContextRoom}:role:${user.audience}`);
    if (user.warehouseId) {
      socket.join(`${selectedContextRoom}:warehouse:${user.warehouseId}`);
    }

    socket.emit("driver:realtime:ready", {
      connectedAt: new Date().toISOString(),
      userId: user.id,
    });
  });

  startSessionSweep(io);
  return io;
}

function getIo() {
  return io;
}

export async function emitPersistedDriverNotification(notificationId: string) {
  if (!notificationId) return;
  const created = await prisma.userNotification.findUnique({ where: { id: notificationId } });
  if (created?.type !== "order" || !created.dispatchTrackingId || !created.orderId || !created.tenantId || !created.companyId || !created.companyMembershipId) {
    recordSuppressedDelivery("driver:notification", "missing_persisted_dispatch_source");
    return;
  }
  const source = await prisma.tracking.findFirst({ where: { id: created.dispatchTrackingId, orderId: created.orderId }, select: { id: true } });
  if (!source) return;
  const context = await resolveOrderRecipientContext({ eventType: "driver:notification", orderId: created.orderId, userId: created.userId });
  if (!context || context.tenantId !== created.tenantId || context.companyId !== created.companyId || context.companyMembershipId !== created.companyMembershipId) return;
  const event: DriverRealtimeNotification = {
    id: created.id, type: created.type, title: created.title, body: created.body,
    at: created.createdAt.toISOString(), orderId: created.orderId,
  };

  const server = getIo();
  if (!server) return;
  await emitToLiveRecipients(server, context, "driver:notification", event, "drivers.telemetry");
  await emitDriverUnreadCount({
    id: context.userId,
    membershipId: context.companyMembershipId,
    companyMembershipId: context.companyMembershipId,
    companyId: context.companyId,
    tenantId: context.tenantId,
    tenantMembershipId: context.tenantMembershipId,
  });
}

export async function emitDriverOrderUpdate(userId: string, payload: DriverOrderRealtimeUpdate) {
  const server = getIo();
  if (!server || !userId) return;
  const context = await resolveOrderRecipientContext({
    eventType: "driver:order-updated",
    orderId: payload.orderId,
    userId,
  });
  if (!context) return;
  await emitToLiveRecipients(server, context, "driver:order-updated", payload, "drivers.telemetry");
}

export async function emitDriverUnreadCount(context: NotificationAccessContext) {
  const server = getIo();
  if (!server) return;
  try {
    const unreadCount = await countUnreadUserNotifications(context);
    await emitToLiveRecipients(server, {
      userId: context.id,
      tenantMembershipId: context.tenantMembershipId,
      tenantId: context.tenantId,
      companyId: context.companyId,
      companyMembershipId: context.companyMembershipId,
    }, "driver:notifications:unread-count", {
      unreadCount,
      at: new Date().toISOString(),
    });
  } catch {
    recordSuppressedDelivery("driver:notifications:unread-count", "recipient_context_ineligible");
    disconnectRecipientSockets(server, {
      userId: String(context?.id ?? ""),
      tenantId: String(context?.tenantId ?? ""),
      companyId: String(context?.companyId ?? ""),
    });
  }
}
