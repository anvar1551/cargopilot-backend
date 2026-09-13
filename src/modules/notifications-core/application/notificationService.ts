import prisma from "../../../config/prismaClient";
import { NotificationType, Prisma } from "@prisma/client";
import { loadAccessSnapshot } from "../../identity-access/access-control";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export type NotificationAccessContext = {
  id: string;
  membershipId: string;
  companyMembershipId: string;
  companyId: string;
  tenantId: string;
  tenantMembershipId: string;
};

type ResolvedNotificationContext = {
  userId: string;
  companyMembershipId: string;
  companyId: string;
  tenantId: string;
  tenantMembershipId: string;
};

export type NotificationSource =
  | { kind: "order"; orderId: string }
  | { kind: "support_ticket"; ticketId: string };

function notificationError(message: string, statusCode = 403) {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function retentionDays() {
  const raw = Number(process.env.DRIVER_NOTIFICATIONS_RETENTION_DAYS ?? 30);
  if (!Number.isFinite(raw) || raw <= 0) return 30;
  return Math.floor(raw);
}

function retentionCutoff() {
  return new Date(Date.now() - retentionDays() * 24 * 60 * 60 * 1000);
}

function encodeCursor(input: { createdAt: Date; id: string }) {
  return Buffer.from(`${input.createdAt.toISOString()}|${input.id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor?: string | null) {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const [createdAtRaw, id] = decoded.split("|");
    if (!createdAtRaw || !id) return null;
    const createdAt = new Date(createdAtRaw);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function parseLimit(value: unknown) {
  const parsed = Number(value ?? DEFAULT_LIMIT);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(parsed), 1), MAX_LIMIT);
}

function normalizedContext(input: NotificationAccessContext) {
  const context = {
    userId: String(input?.id ?? "").trim(),
    membershipId: String(input?.membershipId ?? "").trim(),
    companyMembershipId: String(input?.companyMembershipId ?? "").trim(),
    companyId: String(input?.companyId ?? "").trim(),
    tenantId: String(input?.tenantId ?? "").trim(),
    tenantMembershipId: String(input?.tenantMembershipId ?? "").trim(),
  };
  if (!context.userId || !context.membershipId || !context.companyMembershipId
    || !context.companyId || !context.tenantId || !context.tenantMembershipId
    || context.membershipId !== context.companyMembershipId) {
    throw notificationError("Active notification context required");
  }
  return context;
}

async function requireCurrentContext(input: NotificationAccessContext): Promise<ResolvedNotificationContext> {
  const expected = normalizedContext(input);
  const snapshot = await loadAccessSnapshot({
    userId: expected.userId,
    membershipId: expected.membershipId,
    companyMembershipId: expected.companyMembershipId,
    companyId: expected.companyId,
    tenantId: expected.tenantId,
    tenantMembershipId: expected.tenantMembershipId,
    requireFresh: true,
  });
  if (!snapshot) throw notificationError("Notification context is no longer eligible");
  return {
    userId: snapshot.userId,
    companyMembershipId: snapshot.companyMembershipId,
    companyId: snapshot.companyId,
    tenantId: snapshot.tenantId,
    tenantMembershipId: snapshot.tenantMembershipId,
  };
}

async function resolveRecipientMembership(args: {
  userId: string;
  tenantId: string;
  companyId: string;
  permission: string;
}): Promise<ResolvedNotificationContext | null> {
  const membership = await prisma.companyMembership.findUnique({
    where: { userId_companyId: { userId: args.userId, companyId: args.companyId } },
    select: { id: true, tenantMembershipId: true },
  });
  if (!membership?.id || !membership.tenantMembershipId) return null;
  const snapshot = await loadAccessSnapshot({
    userId: args.userId,
    membershipId: membership.id,
    companyMembershipId: membership.id,
    companyId: args.companyId,
    tenantId: args.tenantId,
    tenantMembershipId: membership.tenantMembershipId,
    requireFresh: true,
  });
  if (!snapshot || !snapshot.permissionCodes.includes(args.permission)) return null;
  return {
    userId: snapshot.userId,
    companyMembershipId: snapshot.companyMembershipId,
    companyId: snapshot.companyId,
    tenantId: snapshot.tenantId,
    tenantMembershipId: snapshot.tenantMembershipId,
  };
}

async function resolveSourceOwnership(userId: string, source: NotificationSource) {
  if (source.kind === "order") {
    const orderId = String(source.orderId ?? "").trim();
    if (!orderId) return null;
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, tenantId: true, ownerOrgId: true, assignedDriverId: true },
    });
    if (!order?.tenantId || !order.ownerOrgId || order.assignedDriverId !== userId) return null;
    const context = await resolveRecipientMembership({
      userId,
      tenantId: order.tenantId,
      companyId: order.ownerOrgId,
      permission: "drivers.telemetry",
    });
    return context ? { context, orderId: order.id } : null;
  }

  const ticketId = String(source.ticketId ?? "").trim();
  if (!ticketId) return null;
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: {
      id: true,
      orderId: true,
      ownerId: true,
      ownerOrgId: true,
      ownerOrg: { select: { tenantId: true } },
      queue: { select: { defaultOwnerId: true } },
    },
  });
  const tenantId = ticket?.ownerOrg?.tenantId ?? null;
  const allowedRecipient = ticket?.ownerId === userId || ticket?.queue?.defaultOwnerId === userId;
  if (!ticket?.ownerOrgId || !tenantId || !allowedRecipient) return null;
  const context = await resolveRecipientMembership({
    userId,
    tenantId,
    companyId: ticket.ownerOrgId,
    permission: "support.update",
  });
  return context ? { context, orderId: ticket.orderId ?? null } : null;
}

export type NotificationListParams = {
  limit?: number;
  cursor?: string | null;
  type?: NotificationType | null;
  unread?: boolean | null;
};

export async function createUserNotification(input: {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  source: NotificationSource;
  data?: Prisma.InputJsonValue | null;
}) {
  const userId = String(input.userId ?? "").trim();
  if (!userId) throw new Error("userId is required");
  const title = String(input.title ?? "").trim();
  const body = String(input.body ?? "").trim();
  if (!title || !body) throw new Error("title and body are required");

  const ownership = await resolveSourceOwnership(userId, input.source);
  if (!ownership) return null;
  return prisma.userNotification.create({
    data: {
      userId,
      tenantId: ownership.context.tenantId,
      companyId: ownership.context.companyId,
      companyMembershipId: ownership.context.companyMembershipId,
      type: input.type,
      title,
      body,
      orderId: ownership.orderId,
      data: input.data == null ? Prisma.JsonNull : input.data,
    },
  });
}

function contextWhere(context: ResolvedNotificationContext) {
  return {
    userId: context.userId,
    tenantId: context.tenantId,
    companyId: context.companyId,
    companyMembershipId: context.companyMembershipId,
  };
}

function serializeNotification(item: {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  createdAt: Date;
  readAt: Date | null;
  orderId: string | null;
}) {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    body: item.body,
    at: item.createdAt.toISOString(),
    unread: !item.readAt,
    orderId: item.orderId,
  };
}

export async function listUserNotifications(contextInput: NotificationAccessContext, params: NotificationListParams = {}) {
  const context = await requireCurrentContext(contextInput);
  const limit = parseLimit(params.limit);
  const cursor = decodeCursor(params.cursor);
  const whereBase: Prisma.UserNotificationWhereInput = {
    ...contextWhere(context),
    createdAt: { gte: retentionCutoff() },
    ...(params.type ? { type: params.type } : {}),
    ...(params.unread === true ? { readAt: null } : params.unread === false ? { readAt: { not: null } } : {}),
  };
  const where: Prisma.UserNotificationWhereInput = cursor ? {
    AND: [whereBase, { OR: [
      { createdAt: { lt: cursor.createdAt } },
      { AND: [{ createdAt: cursor.createdAt }, { id: { lt: cursor.id } }] },
    ] }],
  } : whereBase;
  const rows = await prisma.userNotification.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const tail = items[items.length - 1];
  return {
    items: items.map(serializeNotification),
    hasMore,
    nextCursor: hasMore && tail ? encodeCursor({ createdAt: tail.createdAt, id: tail.id }) : null,
    limit,
  };
}

export async function getUserNotification(contextInput: NotificationAccessContext, notificationId: string) {
  const context = await requireCurrentContext(contextInput);
  const item = await prisma.userNotification.findFirst({
    where: { id: notificationId, ...contextWhere(context) },
  });
  return item ? serializeNotification(item) : null;
}

export async function countUnreadUserNotifications(
  contextInput: NotificationAccessContext,
  type?: NotificationType | null,
) {
  const context = await requireCurrentContext(contextInput);
  return prisma.userNotification.count({
    where: {
      ...contextWhere(context),
      createdAt: { gte: retentionCutoff() },
      readAt: null,
      ...(type ? { type } : {}),
    },
  });
}

export async function markUserNotificationRead(
  contextInput: NotificationAccessContext,
  notificationId: string,
) {
  const context = await requireCurrentContext(contextInput);
  const where = { id: notificationId, ...contextWhere(context) };
  const found = await prisma.userNotification.findFirst({
    where,
    select: { id: true, readAt: true },
  });
  if (!found || found.readAt) return found;
  const readAt = new Date();
  const result = await prisma.userNotification.updateMany({
    where: { ...where, readAt: null },
    data: { readAt },
  });
  if (result.count !== 1) {
    return prisma.userNotification.findFirst({
      where,
      select: { id: true, readAt: true },
    });
  }
  return { id: found.id, readAt };
}

export async function markAllUserNotificationsRead(
  contextInput: NotificationAccessContext,
  type?: NotificationType | null,
) {
  const context = await requireCurrentContext(contextInput);
  const result = await prisma.userNotification.updateMany({
    where: {
      ...contextWhere(context),
      readAt: null,
      createdAt: { gte: retentionCutoff() },
      ...(type ? { type } : {}),
    },
    data: { readAt: new Date() },
  });
  return result.count;
}

export async function cleanupExpiredNotifications() {
  return prisma.userNotification.deleteMany({
    where: { createdAt: { lt: retentionCutoff() } },
  });
}
