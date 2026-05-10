import prisma from "../../config/prismaClient";
import {
  Prisma,
  SupportTicketAuthorType,
  SupportTicketEventType,
  SupportTicketPriority,
  SupportTicketSource,
  SupportTicketStatus,
  AppRole,
} from "@prisma/client";
import { getOrComputeSupportCached, invalidateSupportCache } from "./supportCache";
import { publishSupportRefresh } from "./supportRealtime";

type Actor = {
  id: string;
  role?: AppRole | string;
  name?: string;
  email?: string;
};

export type ListSupportTicketsArgs = {
  status?: string | null;
  priority?: string | null;
  source?: string | null;
  owner?: "mine" | "unassigned" | "all" | null;
  q?: string | null;
  cursor?: string | null;
  limit?: number | null;
  includeArchived?: boolean;
  actor: Actor;
};

export type CreateSupportTicketInput = {
  orderId?: string | null;
  orderNumber?: string | null;
  title: string;
  summary?: string | null;
  priority?: SupportTicketPriority;
  source?: SupportTicketSource;
  status?: SupportTicketStatus;
  ownerId?: string | null;
  sourceKey?: string | null;
};

export type SupportAssignee = {
  id: string;
  name: string;
  email: string;
  role: AppRole;
};

function scheduleSupportRefresh(
  reason: Parameters<typeof publishSupportRefresh>[0],
  ticketId?: string | null,
) {
  void invalidateSupportCache(ticketId).catch((err: any) => {
    console.error(`[support] async cache invalidation failed: ${err?.message || "unknown"}`);
  });
  void publishSupportRefresh(reason, { ticketId }).catch((err: any) => {
    console.error(`[support] async refresh publish failed: ${err?.message || "unknown"}`);
  });
}

function normalizeLimit(value?: number | null) {
  if (!Number.isFinite(value || 0)) return 30;
  return Math.min(80, Math.max(10, Math.floor(Number(value))));
}

function isEnumValue<T extends Record<string, string>>(enumObj: T, value?: string | null): value is T[keyof T] {
  return Boolean(value && Object.values(enumObj).includes(value));
}

function encodeCursor(input: { lastActivityAt: Date; id: string }) {
  return Buffer.from(`${input.lastActivityAt.toISOString()}|${input.id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor?: string | null) {
  if (!cursor) return null;
  try {
    const [dateRaw, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    const date = new Date(dateRaw);
    if (!id || Number.isNaN(date.getTime())) return null;
    return { lastActivityAt: date, id };
  } catch {
    return null;
  }
}

async function getNextTicketNumber(tx: any) {
  const counter = await tx.counter.upsert({
    where: { key: "supportTicketNumber" },
    update: { value: { increment: 1 } },
    create: { key: "supportTicketNumber", value: 1 },
  });
  return `ST-${String(counter.value).padStart(6, "0")}`;
}

function actorName(actor: Actor) {
  return actor.name || actor.email || "Support";
}

function actorId(actor: Actor) {
  const id = String(actor.id || "").trim();
  return id || null;
}

function getAuthorType(actor: Actor): SupportTicketAuthorType {
  if (actor.role === "driver") return SupportTicketAuthorType.driver;
  if (actor.role === "customer") return SupportTicketAuthorType.customer;
  return SupportTicketAuthorType.support;
}

function strongestPriority(
  current?: SupportTicketPriority | null,
  next?: SupportTicketPriority | null,
) {
  const rank: Record<SupportTicketPriority, number> = {
    normal: 1,
    high: 2,
    urgent: 3,
  };
  const currentPriority = current || SupportTicketPriority.normal;
  const nextPriority = next || SupportTicketPriority.normal;
  return rank[nextPriority] > rank[currentPriority] ? nextPriority : currentPriority;
}

function buildRoute(order?: {
  pickupAddress?: string | null;
  dropoffAddress?: string | null;
} | null) {
  const from = String(order?.pickupAddress || "").trim();
  const to = String(order?.dropoffAddress || "").trim();
  if (from && to) return `${from} -> ${to}`;
  return from || to || null;
}

function serializeTicket(ticket: any) {
  const messages = Array.isArray(ticket.messages) ? ticket.messages : [];
  const notes = Array.isArray(ticket.notes) ? ticket.notes : [];
  const events = Array.isArray(ticket.events) ? ticket.events : [];

  return {
    id: ticket.id,
    ticketNumber: ticket.ticketNumber,
    sourceKey: ticket.sourceKey ?? null,
    orderId: ticket.orderId,
    orderNumber: ticket.order?.orderNumber ?? null,
    title: ticket.title,
    summary: ticket.summary,
    priority: ticket.priority,
    status: ticket.status,
    source: ticket.source,
    customerUserId: ticket.customerUserId,
    customerEntityId: ticket.customerEntityId,
    driverId: ticket.driverId,
    warehouseId: ticket.warehouseId,
    ownerId: ticket.ownerId,
    ownerName: ticket.ownerName,
    customerName: ticket.customerName,
    companyName: ticket.companyName,
    route: ticket.routeSnapshot,
    driverName: ticket.driverName,
    driverPhone: ticket.driverPhone,
    warehouseLabel: ticket.warehouseLabel,
    lastMessage: ticket.lastMessage,
    lastReplyBy: ticket.lastReplyBy,
    slaPercent: ticket.slaPercent,
    slaDueAt: ticket.slaDueAt?.toISOString?.() ?? null,
    lastActivityAt: ticket.lastActivityAt?.toISOString?.() ?? null,
    resolvedAt: ticket.resolvedAt?.toISOString?.() ?? null,
    archivedAt: ticket.archivedAt?.toISOString?.() ?? null,
    createdAt: ticket.createdAt?.toISOString?.() ?? null,
    updatedAt: ticket.updatedAt?.toISOString?.() ?? null,
    messages: messages.map((message: any) => ({
      id: message.id,
      authorType: message.authorType,
      authorId: message.authorId,
      authorName: message.authorName,
      body: message.body,
      createdAt: message.createdAt?.toISOString?.() ?? null,
    })),
    notes: notes.map((note: any) => ({
      id: note.id,
      actorId: note.actorId,
      actorName: note.actorName,
      body: note.body,
      createdAt: note.createdAt?.toISOString?.() ?? null,
    })),
    events: events.map((event: any) => ({
      id: event.id,
      eventType: event.eventType,
      actorId: event.actorId,
      actorName: event.actorName,
      body: event.body,
      metadata: event.metadata,
      createdAt: event.createdAt?.toISOString?.() ?? null,
    })),
  };
}

const ticketSelect = {
  id: true,
  ticketNumber: true,
  sourceKey: true,
  orderId: true,
  title: true,
  summary: true,
  priority: true,
  status: true,
  source: true,
  customerUserId: true,
  customerEntityId: true,
  driverId: true,
  warehouseId: true,
  ownerId: true,
  ownerName: true,
  customerName: true,
  companyName: true,
  routeSnapshot: true,
  driverName: true,
  driverPhone: true,
  warehouseLabel: true,
  lastMessage: true,
  lastReplyBy: true,
  slaPercent: true,
  slaDueAt: true,
  lastActivityAt: true,
  resolvedAt: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  order: {
    select: {
      id: true,
      orderNumber: true,
      pickupAddress: true,
      dropoffAddress: true,
      status: true,
    },
  },
} as const;

function buildListWhere(args: ListSupportTicketsArgs) {
  const where: any = {};

  if (!args.includeArchived) where.archivedAt = null;

  if (isEnumValue(SupportTicketStatus, args.status)) {
    where.status = args.status;
  }
  if (isEnumValue(SupportTicketPriority, args.priority)) {
    where.priority = args.priority;
  }
  if (isEnumValue(SupportTicketSource, args.source)) {
    where.source = args.source;
  }
  if (args.owner === "mine") {
    where.ownerId = args.actor.id;
  } else if (args.owner === "unassigned") {
    where.ownerId = null;
  }

  const cursor = decodeCursor(args.cursor);
  if (cursor) {
    where.OR = [
      { lastActivityAt: { lt: cursor.lastActivityAt } },
      { lastActivityAt: cursor.lastActivityAt, id: { lt: cursor.id } },
    ];
  }

  const q = String(args.q || "").trim();
  if (q) {
    const searchOr = [
      { ticketNumber: { contains: q, mode: "insensitive" } },
      { title: { contains: q, mode: "insensitive" } },
      { summary: { contains: q, mode: "insensitive" } },
      { customerName: { contains: q, mode: "insensitive" } },
      { companyName: { contains: q, mode: "insensitive" } },
      { routeSnapshot: { contains: q, mode: "insensitive" } },
      { driverName: { contains: q, mode: "insensitive" } },
      { driverPhone: { contains: q, mode: "insensitive" } },
      { order: { is: { orderNumber: { contains: q, mode: "insensitive" } } } },
    ];
    if (where.OR) {
      where.AND = [{ OR: where.OR }, { OR: searchOr }];
      delete where.OR;
    } else {
      where.OR = searchOr;
    }
  }

  return where;
}

function intFromDb(value: unknown) {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function computeSupportSummary(args: { includeArchived?: boolean }) {
  const todayStart = new Date(new Date().setHours(0, 0, 0, 0));
  const now = new Date();
  const archivedFilter = args.includeArchived
    ? Prisma.empty
    : Prisma.sql`WHERE "archivedAt" IS NULL`;

  const [row] = await prisma.$queryRaw<
    Array<{
      open: bigint | number;
      escalated: bigint | number;
      waitingCustomer: bigint | number;
      waitingDriver: bigint | number;
      resolvedToday: bigint | number;
      slaRisk: bigint | number;
    }>
  >`
    SELECT
      COUNT(*) FILTER (WHERE "status" <> 'resolved') AS "open",
      COUNT(*) FILTER (WHERE "status" = 'escalated') AS "escalated",
      COUNT(*) FILTER (WHERE "status" = 'waiting_customer') AS "waitingCustomer",
      COUNT(*) FILTER (WHERE "status" = 'waiting_driver') AS "waitingDriver",
      COUNT(*) FILTER (
        WHERE "status" = 'resolved'
          AND "resolvedAt" >= ${todayStart}
      ) AS "resolvedToday",
      COUNT(*) FILTER (
        WHERE "status" <> 'resolved'
          AND ("slaPercent" <= 25 OR "slaDueAt" <= ${now})
      ) AS "slaRisk"
    FROM "SupportTicket"
    ${archivedFilter}
  `;

  const open = intFromDb(row?.open);
  const escalated = intFromDb(row?.escalated);
  const waitingCustomer = intFromDb(row?.waitingCustomer);
  const waitingDriver = intFromDb(row?.waitingDriver);
  const resolvedToday = intFromDb(row?.resolvedToday);
  const slaRisk = intFromDb(row?.slaRisk);

  return {
    open,
    escalated,
    waitingCustomer,
    waitingDriver,
    waiting: waitingCustomer + waitingDriver,
    resolvedToday,
    slaRisk,
  };
}

async function getSupportSummaryCached(args: { includeArchived?: boolean }) {
  const key = JSON.stringify({ includeArchived: Boolean(args.includeArchived) });
  const result = await getOrComputeSupportCached({
    namespace: "summary",
    key,
    ttlMs: Number(process.env.SUPPORT_SUMMARY_CACHE_TTL_MS || 60_000),
    compute: () => computeSupportSummary(args),
  });
  return result.payload;
}

export async function listSupportTickets(args: ListSupportTicketsArgs) {
  const limit = normalizeLimit(args.limit);
  const key = JSON.stringify({
    status: args.status || "all",
    priority: args.priority || "all",
    source: args.source || "all",
    owner: args.owner || "mine",
    q: String(args.q || "").trim(),
    cursor: args.cursor || "",
    limit,
    includeArchived: Boolean(args.includeArchived),
    actorId: args.actor.id,
  });

  return getOrComputeSupportCached({
    namespace: "list",
    key,
    ttlMs: 20_000,
    compute: async () => {
      const where = buildListWhere(args);
      const rows = await prisma.supportTicket.findMany({
        where,
        select: ticketSelect,
        orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      });
      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      const items = pageRows.map(serializeTicket);
      const last = pageRows[pageRows.length - 1];
      const summary = await getSupportSummaryCached({
        includeArchived: Boolean(args.includeArchived),
      });

      return {
        items,
        hasMore,
        nextCursor: hasMore && last ? encodeCursor({ lastActivityAt: last.lastActivityAt, id: last.id }) : null,
        summary,
      };
    },
  });
}

async function loadSerializedTicketFresh(id: string) {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id },
    select: {
      ...ticketSelect,
      messages: { orderBy: { createdAt: "asc" }, take: 100 },
      notes: { orderBy: { createdAt: "asc" }, take: 100 },
      events: { orderBy: { createdAt: "asc" }, take: 120 },
    },
  });
  if (!ticket) return null;
  return serializeTicket(ticket);
}

export async function getSupportTicket(id: string) {
  return getOrComputeSupportCached({
    namespace: "detail",
    key: id,
    ttlMs: 30_000,
    compute: () => loadSerializedTicketFresh(id),
  });
}

function normalizeOrderNumber(value?: string | null) {
  return String(value || "").trim().replace(/^#/, "");
}

async function loadOrderSnapshot(input?: { orderId?: string | null; orderNumber?: string | null } | null) {
  const orderId = String(input?.orderId || "").trim();
  const orderNumber = normalizeOrderNumber(input?.orderNumber);
  if (!orderId && !orderNumber) return null;
  return prisma.order.findUnique({
    where: orderId ? { id: orderId } : { orderNumber },
    select: {
      id: true,
      orderNumber: true,
      pickupAddress: true,
      dropoffAddress: true,
      customerId: true,
      customerEntityId: true,
      assignedDriverId: true,
      currentWarehouseId: true,
      customer: { select: { name: true, email: true } },
      customerEntity: { select: { name: true, email: true } },
      assignedDriver: { select: { name: true, email: true } },
      currentWarehouse: { select: { name: true, location: true } },
    },
  });
}

export async function createSupportTicket(input: CreateSupportTicketInput, actor: Actor) {
  const order = await loadOrderSnapshot({
    orderId: input.orderId,
    orderNumber: input.orderNumber,
  });
  const now = new Date();
  const title = String(input.title || "").trim();
  if (!title) throw new Error("Title is required");
  if ((input.orderId || input.orderNumber) && !order) {
    throw new Error("Order not found");
  }

  const sourceKey = String(input.sourceKey || "").trim() || null;
  if (sourceKey) {
    const existing = await prisma.supportTicket.findUnique({
      where: { sourceKey },
      select: {
        ...ticketSelect,
        messages: { orderBy: { createdAt: "asc" }, take: 100 },
        notes: { orderBy: { createdAt: "asc" }, take: 100 },
        events: { orderBy: { createdAt: "asc" }, take: 120 },
      },
    });
    if (existing && !existing.archivedAt && existing.status !== SupportTicketStatus.resolved) {
      return serializeTicket(existing);
    }
  }

  if (order?.id) {
    const existingForOrder = await prisma.supportTicket.findFirst({
      where: {
        orderId: order.id,
        archivedAt: null,
        status: { not: SupportTicketStatus.resolved },
      },
      select: ticketSelect,
      orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
    });

    if (existingForOrder) {
      const merged = await prisma.$transaction(async (tx) => {
        const owner = input.ownerId
          ? await tx.user.findUnique({
              where: { id: input.ownerId },
              select: { id: true, name: true, email: true },
            })
          : null;
        const shouldChangeOwner = input.ownerId !== undefined;
        const mergedSummary = input.summary?.trim() || title;
        const mergedStatus =
          input.status === SupportTicketStatus.escalated
            ? SupportTicketStatus.escalated
            : existingForOrder.status;
        const mergedPriority = strongestPriority(existingForOrder.priority, input.priority);

        const ticket = await tx.supportTicket.update({
          where: { id: existingForOrder.id },
          data: {
            priority: mergedPriority,
            status: mergedStatus,
            ownerId: shouldChangeOwner ? owner?.id ?? null : existingForOrder.ownerId,
            ownerName: shouldChangeOwner
              ? owner?.name || owner?.email || null
              : existingForOrder.ownerName,
            lastMessage: mergedSummary,
            lastReplyBy: getAuthorType(actor),
            lastActivityAt: now,
          },
          select: ticketSelect,
        });

        await tx.supportTicketEvent.create({
          data: {
            ticketId: ticket.id,
            eventType:
              mergedStatus === SupportTicketStatus.escalated
                ? SupportTicketEventType.escalated
                : SupportTicketEventType.message_added,
            actorId: actorId(actor),
            actorName: actorName(actor),
            body: `Merged new support request: ${title}`,
            metadata: {
              source: input.source || SupportTicketSource.manager,
              requestedPriority: input.priority || SupportTicketPriority.normal,
              summary: input.summary?.trim() || null,
            },
          },
        });

        return ticket;
      });

      scheduleSupportRefresh("ticket_updated", merged.id);
      return loadSerializedTicketFresh(merged.id);
    }
  }

  const created = await prisma.$transaction(async (tx) => {
    const ticketNumber = await getNextTicketNumber(tx);
    const ticket = await tx.supportTicket.create({
      data: {
        ticketNumber,
        sourceKey,
        orderId: order?.id ?? null,
        title,
        summary: input.summary?.trim() || null,
        priority: input.priority || SupportTicketPriority.normal,
        status: input.status || SupportTicketStatus.open,
        source: input.source || SupportTicketSource.manager,
        customerUserId: order?.customerId ?? null,
        customerEntityId: order?.customerEntityId ?? null,
        driverId: order?.assignedDriverId ?? null,
        warehouseId: order?.currentWarehouseId ?? null,
        ownerId: input.ownerId === undefined ? actor.id : input.ownerId,
        ownerName: input.ownerId === null ? null : actorName(actor),
        customerName: order?.customerEntity?.name || order?.customer?.name || null,
        companyName: order?.customerEntity?.name || order?.customer?.email || null,
        routeSnapshot: buildRoute(order),
        driverName: order?.assignedDriver?.name || null,
        driverPhone: order?.assignedDriver?.email || null,
        warehouseLabel: order?.currentWarehouse?.name || null,
        lastMessage: input.summary?.trim() || title,
        lastReplyBy: getAuthorType(actor),
        slaPercent: 100,
        slaDueAt: new Date(now.getTime() + 4 * 60 * 60 * 1000),
        lastActivityAt: now,
      },
      select: ticketSelect,
    });
    await tx.supportTicketEvent.create({
      data: {
        ticketId: ticket.id,
        eventType: SupportTicketEventType.created,
        actorId: actorId(actor),
        actorName: actorName(actor),
        body: "Ticket created",
        metadata: { source: input.source || SupportTicketSource.manager },
      },
    });
    return ticket;
  });

  scheduleSupportRefresh("ticket_created", created.id);
  return serializeTicket(created);
}

export async function listSupportAssignees(): Promise<SupportAssignee[]> {
  const users = await prisma.user.findMany({
    where: { role: AppRole.manager },
    orderBy: [{ name: "asc" }, { email: "asc" }],
    select: { id: true, name: true, email: true, role: true },
    take: 200,
  });
  return users;
}

export async function updateSupportTicketStatus(ticketId: string, status: SupportTicketStatus, actor: Actor) {
  const now = new Date();
  const data: any = {
    status,
    lastActivityAt: now,
  };
  if (status === SupportTicketStatus.resolved) data.resolvedAt = now;
  if (status !== SupportTicketStatus.resolved) data.resolvedAt = null;

  const updated = await prisma.$transaction(async (tx) => {
    const ticket = await tx.supportTicket.update({
      where: { id: ticketId },
      data,
      select: ticketSelect,
    });
    await tx.supportTicketEvent.create({
      data: {
        ticketId,
        eventType:
          status === SupportTicketStatus.escalated
            ? SupportTicketEventType.escalated
            : status === SupportTicketStatus.resolved
              ? SupportTicketEventType.resolved
              : SupportTicketEventType.status_changed,
        actorId: actorId(actor),
        actorName: actorName(actor),
        body: `Status changed to ${status}`,
      },
    });
    return ticket;
  });

  scheduleSupportRefresh("ticket_updated", ticketId);
  return serializeTicket(updated);
}

export async function assignSupportTicket(ticketId: string, ownerId: string | null, actor: Actor) {
  const updated = await prisma.$transaction(async (tx) => {
    const owner = ownerId
      ? await tx.user.findUnique({ where: { id: ownerId }, select: { id: true, name: true, email: true } })
      : null;
    const ticket = await tx.supportTicket.update({
      where: { id: ticketId },
      data: {
        ownerId: owner?.id ?? null,
        ownerName: owner?.name || owner?.email || null,
        lastActivityAt: new Date(),
      },
      select: ticketSelect,
    });
    await tx.supportTicketEvent.create({
      data: {
        ticketId,
        eventType: SupportTicketEventType.assigned,
        actorId: actorId(actor),
        actorName: actorName(actor),
        body: owner ? `Assigned to ${owner.name || owner.email}` : "Unassigned",
      },
    });
    return ticket;
  });

  scheduleSupportRefresh("ticket_updated", ticketId);
  return serializeTicket(updated);
}

export async function addSupportTicketNote(ticketId: string, body: string, actor: Actor) {
  const text = body.trim();
  if (!text) throw new Error("Note body is required");

  await prisma.$transaction(async (tx) => {
    await tx.supportTicketNote.create({
      data: {
        ticketId,
        actorId: actorId(actor),
        actorName: actorName(actor),
        body: text,
      },
    });
    await tx.supportTicket.update({
      where: { id: ticketId },
      data: { lastActivityAt: new Date() },
    });
    await tx.supportTicketEvent.create({
      data: {
        ticketId,
        eventType: SupportTicketEventType.note_added,
        actorId: actorId(actor),
        actorName: actorName(actor),
        body: "Internal note added",
      },
    });
  });

  scheduleSupportRefresh("note_added", ticketId);
  return loadSerializedTicketFresh(ticketId);
}

export async function addSupportTicketMessage(ticketId: string, body: string, actor: Actor) {
  const text = body.trim();
  if (!text) throw new Error("Message body is required");
  const authorType = getAuthorType(actor);

  await prisma.$transaction(async (tx) => {
    await tx.supportTicketMessage.create({
      data: {
        ticketId,
        authorType,
        authorId: actorId(actor),
        authorName: actorName(actor),
        body: text,
      },
    });
    await tx.supportTicket.update({
      where: { id: ticketId },
      data: {
        lastMessage: text,
        lastReplyBy: authorType,
        lastActivityAt: new Date(),
      },
    });
    await tx.supportTicketEvent.create({
      data: {
        ticketId,
        eventType: SupportTicketEventType.message_added,
        actorId: actorId(actor),
        actorName: actorName(actor),
        body: "Message added",
      },
    });
  });

  scheduleSupportRefresh("message_added", ticketId);
  return loadSerializedTicketFresh(ticketId);
}

export async function archiveResolvedSupportTickets(days = 30) {
  const cutoff = new Date(Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000);
  const result = await prisma.supportTicket.updateMany({
    where: {
      status: SupportTicketStatus.resolved,
      archivedAt: null,
      resolvedAt: { lt: cutoff },
    },
    data: { archivedAt: new Date() },
  });
  if (result.count > 0) {
    await invalidateSupportCache();
    await publishSupportRefresh("ticket_archived", { keys: ["list", "summary"] });
  }
  return result.count;
}
