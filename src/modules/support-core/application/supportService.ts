import prisma from "../../../config/prismaClient";
import {
  NotificationType,
  Prisma,
  SupportTicketAuthorType,
  SupportTicketEventType,
  SupportTicketPriority,
  SupportTicketSource,
  SupportTicketStatus,
} from "@prisma/client";
import { getOrComputeSupportCached, invalidateSupportCache } from "../infrastructure/supportCache";
import { publishSupportRefresh } from "../realtime/supportRealtime";
import { enqueueCargoPilotDomainEventTx } from "../../analytics-core/infrastructure/analyticsOutbox";
import { createUserNotification } from "../../notifications-core/application/notificationService";

type Actor = {
  id: string;
  companyId?: string | null;
  permissionCodes?: string[];
  customerEntityId?: string | null;
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
  scopeWhere?: Prisma.SupportTicketWhereInput | null;
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
  routingKey?: string | null;
  companyId?: string | null;
};

export type SupportAssignee = {
  id: string;
  name: string;
  email: string;
};

function scheduleSupportRefresh(
  reason: Parameters<typeof publishSupportRefresh>[0],
  ticketId?: string | null,
) {
  void invalidateSupportCache(ticketId).catch((err: any) => {
    console.error(`[support] async cache invalidation failed: ${err?.message || "unknown"}`);
  });
  if (process.env.SUPPORT_DIRECT_REFRESH !== "true") return;
  void publishSupportRefresh(reason, { ticketId }).catch((err: any) => {
    console.error(`[support] async refresh publish failed: ${err?.message || "unknown"}`);
  });
}

function supportTenantScope(actor: Actor) {
  const companyId = actorCompanyId(actor);
  if (companyId) return `company:${companyId}`;
  return actor.id ? `user:${actor.id}` : "global";
}

async function enqueueSupportTicketChangedTx(
  tx: any,
  args: {
    ticketId: string;
    reason: Parameters<typeof publishSupportRefresh>[0];
    actor: Actor;
    payload?: Record<string, unknown>;
  },
) {
  await enqueueCargoPilotDomainEventTx(tx, {
    type: "support_ticket_changed",
    tenantScope: supportTenantScope(args.actor),
    entityId: args.ticketId,
    payload: {
      reason: args.reason,
      actorId: actorId(args.actor),
      actorRole: null,
      ...(args.payload ?? {}),
    },
  });
}

function normalizeLimit(value?: number | null) {
  if (!Number.isFinite(value || 0)) return 30;
  return Math.min(80, Math.max(10, Math.floor(Number(value))));
}

function normalizeSearchQuery(value?: string | null) {
  const raw = String(value || "").trim().slice(0, 80);
  if (raw.length < 2) return "";
  return raw;
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
  if (!actorId(actor)) return SupportTicketAuthorType.system;
  const permissions = new Set(
    Array.isArray(actor.permissionCodes)
      ? actor.permissionCodes.map((value) => String(value || "").trim())
      : [],
  );
  if (permissions.has("drivers.telemetry")) {
    return SupportTicketAuthorType.driver;
  }
  if (actor.customerEntityId) {
    return SupportTicketAuthorType.customer;
  }
  return SupportTicketAuthorType.support;
}

function actorCompanyId(actor: Actor) {
  return String(actor.companyId || "").trim() || null;
}

function normalizeCode(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
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

function fallbackSlaTargetMinutes(priority: SupportTicketPriority) {
  switch (priority) {
    case SupportTicketPriority.urgent:
      return 2 * 60;
    case SupportTicketPriority.high:
      return 8 * 60;
    case SupportTicketPriority.normal:
    default:
      return 24 * 60;
  }
}

async function resolveSupportSla(args: {
  companyId?: string | null;
  queueId?: string | null;
  priority: SupportTicketPriority;
  from: Date;
}) {
  const companyId = String(args.companyId || "").trim();
  const queueId = String(args.queueId || "").trim() || null;
  let targetMinutes = fallbackSlaTargetMinutes(args.priority);
  let policyId: string | null = null;

  if (companyId) {
    const policies = await prisma.supportSlaPolicy.findMany({
      where: {
        companyId,
        priority: args.priority,
        isActive: true,
        OR: queueId ? [{ queueId }, { queueId: null }] : [{ queueId: null }],
      },
      orderBy: [{ queueId: "desc" }, { createdAt: "asc" }],
      take: 10,
      select: { id: true, queueId: true, targetMinutes: true },
    });
    const policy =
      (queueId ? policies.find((item) => item.queueId === queueId) : null)
      ?? policies.find((item) => item.queueId === null)
      ?? null;
    if (policy && Number.isFinite(policy.targetMinutes) && policy.targetMinutes > 0) {
      targetMinutes = policy.targetMinutes;
      policyId = policy.id;
    }
  }

  return {
    policyId,
    targetMinutes,
    dueAt: new Date(args.from.getTime() + targetMinutes * 60_000),
  };
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

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function conditionValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  }
  const raw = String(value ?? "").trim();
  return raw ? [raw] : [];
}

function ruleConditionsMatch(
  conditions: unknown,
  args: {
    routingKey?: string | null;
    sourceKey?: string | null;
    title?: string | null;
  },
) {
  const object = asObject(conditions);
  const routingKeys = conditionValues(object.routingKey).map((value) => value.toLowerCase());
  if (routingKeys.length) {
    const routingKey = String(args.routingKey || "").trim().toLowerCase();
    if (!routingKey || !routingKeys.includes(routingKey)) return false;
  }

  const sourceKeyPrefixes = conditionValues(object.sourceKeyPrefix).map((value) => value.toLowerCase());
  if (sourceKeyPrefixes.length) {
    const sourceKey = String(args.sourceKey || "").trim().toLowerCase();
    if (!sourceKey || !sourceKeyPrefixes.some((prefix) => sourceKey.startsWith(prefix))) {
      return false;
    }
  }

  const titleNeedles = conditionValues(object.titleContains).map((value) => value.toLowerCase());
  if (titleNeedles.length) {
    const title = String(args.title || "").trim().toLowerCase();
    if (!title || !titleNeedles.some((needle) => title.includes(needle))) return false;
  }

  return true;
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
    ownerOrgId: ticket.ownerOrgId,
    assignedOrgId: ticket.assignedOrgId,
    queueId: ticket.queueId,
    queueCode: ticket.queue?.code ?? null,
    queueName: ticket.queue?.name ?? null,
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

const ticketListSelect = {
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
  ownerOrgId: true,
  assignedOrgId: true,
  queueId: true,
  queue: {
    select: {
      id: true,
      code: true,
      name: true,
    },
  },
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
      status: true,
    },
  },
} as const;

const ticketDetailSelect = {
  ...ticketListSelect,
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
  const and: any[] = [];

  if (args.scopeWhere && Object.keys(args.scopeWhere).length > 0) {
    and.push(args.scopeWhere);
  }

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

  const q = normalizeSearchQuery(args.q);
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

  if (and.length > 0) {
    and.push(where);
    return { AND: and };
  }

  return where;
}

function combineSupportWhere(
  scopeWhere: Prisma.SupportTicketWhereInput | null | undefined,
  condition: Prisma.SupportTicketWhereInput,
): Prisma.SupportTicketWhereInput {
  const clauses: Prisma.SupportTicketWhereInput[] = [];
  if (scopeWhere && Object.keys(scopeWhere).length > 0) clauses.push(scopeWhere);
  clauses.push(condition);
  return clauses.length === 1 ? clauses[0] : { AND: clauses };
}

async function computeSupportSummary(args: {
  includeArchived?: boolean;
  scopeWhere?: Prisma.SupportTicketWhereInput | null;
}) {
  const todayStart = new Date(new Date().setHours(0, 0, 0, 0));
  const now = new Date();
  const visibleWhere = combineSupportWhere(args.scopeWhere, {
    ...(args.includeArchived ? {} : { archivedAt: null }),
  });

  const [open, escalated, waitingCustomer, waitingDriver, resolvedToday, slaRisk] =
    await Promise.all([
      prisma.supportTicket.count({
        where: combineSupportWhere(visibleWhere, {
          status: { not: SupportTicketStatus.resolved },
        }),
      }),
      prisma.supportTicket.count({
        where: combineSupportWhere(visibleWhere, {
          status: SupportTicketStatus.escalated,
        }),
      }),
      prisma.supportTicket.count({
        where: combineSupportWhere(visibleWhere, {
          status: SupportTicketStatus.waiting_customer,
        }),
      }),
      prisma.supportTicket.count({
        where: combineSupportWhere(visibleWhere, {
          status: SupportTicketStatus.waiting_driver,
        }),
      }),
      prisma.supportTicket.count({
        where: combineSupportWhere(visibleWhere, {
          status: SupportTicketStatus.resolved,
          resolvedAt: { gte: todayStart },
        }),
      }),
      prisma.supportTicket.count({
        where: combineSupportWhere(visibleWhere, {
          status: { not: SupportTicketStatus.resolved },
          OR: [{ slaPercent: { lte: 25 } }, { slaDueAt: { lte: now } }],
        }),
      }),
    ]);

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

async function getSupportSummaryCached(args: {
  includeArchived?: boolean;
  actor: Actor;
  scopeWhere?: Prisma.SupportTicketWhereInput | null;
}) {
  const key = JSON.stringify({
    includeArchived: Boolean(args.includeArchived),
    actorId: args.actor.id,
    companyId: actorCompanyId(args.actor),
    scopeWhere: args.scopeWhere ?? null,
  });
  const result = await getOrComputeSupportCached({
    namespace: "summary",
    key,
    ttlMs: Number(process.env.SUPPORT_SUMMARY_CACHE_TTL_MS || 60_000),
    compute: () => computeSupportSummary(args),
  });
  return result.payload;
}

export async function getSupportSummary(args: {
  includeArchived?: boolean;
  actor: Actor;
  scopeWhere?: Prisma.SupportTicketWhereInput | null;
}) {
  return getSupportSummaryCached(args);
}

export async function listSupportTickets(args: ListSupportTicketsArgs) {
  const limit = normalizeLimit(args.limit);
  const key = JSON.stringify({
    status: args.status || "all",
    priority: args.priority || "all",
    source: args.source || "all",
    owner: args.owner || "mine",
    q: normalizeSearchQuery(args.q),
    cursor: args.cursor || "",
    limit,
    includeArchived: Boolean(args.includeArchived),
    actorId: args.actor.id,
    companyId: actorCompanyId(args.actor),
    scopeWhere: args.scopeWhere ?? null,
  });

  return getOrComputeSupportCached({
    namespace: "list",
    key,
    ttlMs: 20_000,
    compute: async () => {
      const where = buildListWhere(args);
      const rows = await prisma.supportTicket.findMany({
        where,
        select: ticketListSelect,
        orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      });
      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      const items = pageRows.map(serializeTicket);
      const last = pageRows[pageRows.length - 1];
      const summary = await getSupportSummaryCached({
        includeArchived: Boolean(args.includeArchived),
        actor: args.actor,
        scopeWhere: args.scopeWhere,
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

async function loadSerializedTicketFresh(
  id: string,
  scopeWhere?: Prisma.SupportTicketWhereInput | null,
) {
  const scopedWhere = scopeWhere && Object.keys(scopeWhere).length > 0
    ? { AND: [{ id }, scopeWhere] }
    : { id };

  const ticket = await prisma.supportTicket.findFirst({
    where: scopedWhere,
    select: {
      ...ticketDetailSelect,
      messages: { orderBy: { createdAt: "asc" }, take: 100 },
      notes: { orderBy: { createdAt: "asc" }, take: 100 },
      events: { orderBy: { createdAt: "asc" }, take: 120 },
    },
  });
  if (!ticket) return null;
  return serializeTicket(ticket);
}

export async function getSupportTicket(id: string) {
  return getSupportTicketScoped({ id });
}

export async function getSupportTicketScoped(args: {
  id: string;
  scopeWhere?: Prisma.SupportTicketWhereInput | null;
}) {
  return getOrComputeSupportCached({
    namespace: "detail",
    key: JSON.stringify({
      id: args.id,
      scope: args.scopeWhere || null,
    }),
    ttlMs: 30_000,
    compute: () => loadSerializedTicketFresh(args.id, args.scopeWhere),
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
      ownerOrgId: true,
      assignedOrgId: true,
      customer: { select: { name: true, email: true } },
      customerEntity: { select: { name: true, email: true } },
      assignedDriver: { select: { name: true, email: true } },
      currentWarehouse: { select: { name: true, location: true } },
    },
  });
}

function serializeSupportQueue(queue: any) {
  return {
    id: queue.id,
    companyId: queue.companyId,
    code: queue.code,
    name: queue.name,
    description: queue.description ?? null,
    defaultOrgId: queue.defaultOrgId ?? null,
    defaultOrgName: queue.defaultOrg?.name ?? null,
    defaultOwnerId: queue.defaultOwnerId ?? null,
    isDefault: Boolean(queue.isDefault),
    isActive: Boolean(queue.isActive),
    createdAt: queue.createdAt?.toISOString?.() ?? null,
    updatedAt: queue.updatedAt?.toISOString?.() ?? null,
  };
}

function serializeSupportAssignmentRule(rule: any) {
  return {
    id: rule.id,
    companyId: rule.companyId,
    queueId: rule.queueId ?? null,
    queueCode: rule.queue?.code ?? null,
    queueName: rule.queue?.name ?? null,
    name: rule.name,
    code: rule.code,
    source: rule.source ?? null,
    priority: rule.priority ?? null,
    routeContains: rule.routeContains ?? null,
    defaultOwnerId: rule.defaultOwnerId ?? null,
    conditionsJson: rule.conditionsJson ?? null,
    sortOrder: rule.sortOrder,
    isActive: Boolean(rule.isActive),
    createdAt: rule.createdAt?.toISOString?.() ?? null,
    updatedAt: rule.updatedAt?.toISOString?.() ?? null,
  };
}

export async function listSupportQueues(companyId: string) {
  const normalizedCompanyId = String(companyId || "").trim();
  if (!normalizedCompanyId) throw new Error("companyId is required");

  const rows = await prisma.supportQueue.findMany({
    where: { companyId: normalizedCompanyId },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    include: { defaultOrg: { select: { id: true, name: true } } },
  });
  return rows.map(serializeSupportQueue);
}

export async function createSupportQueue(input: {
  companyId: string;
  code?: string | null;
  name: string;
  description?: string | null;
  defaultOrgId?: string | null;
  defaultOwnerId?: string | null;
  isDefault?: boolean;
  isActive?: boolean;
}) {
  const companyId = String(input.companyId || "").trim();
  const name = String(input.name || "").trim();
  const code = normalizeCode(input.code || name);
  if (!companyId) throw new Error("companyId is required");
  if (!name) throw new Error("Queue name is required");
  if (!code) throw new Error("Queue code is required");

  const queue = await prisma.$transaction(async (tx) => {
    if (input.isDefault) {
      await tx.supportQueue.updateMany({
        where: { companyId, isDefault: true },
        data: { isDefault: false },
      });
    }
    return tx.supportQueue.create({
      data: {
        companyId,
        code,
        name,
        description: input.description?.trim() || null,
        defaultOrgId: input.defaultOrgId || null,
        defaultOwnerId: input.defaultOwnerId || null,
        isDefault: Boolean(input.isDefault),
        isActive: input.isActive !== false,
      },
      include: { defaultOrg: { select: { id: true, name: true } } },
    });
  });

  await invalidateSupportCache();
  return serializeSupportQueue(queue);
}

export async function updateSupportQueue(id: string, input: Partial<{
  code: string | null;
  name: string;
  description: string | null;
  defaultOrgId: string | null;
  defaultOwnerId: string | null;
  isDefault: boolean;
  isActive: boolean;
}>) {
  const queueId = String(id || "").trim();
  if (!queueId) throw new Error("queue id is required");

  const existing = await prisma.supportQueue.findUnique({
    where: { id: queueId },
    select: { id: true, companyId: true },
  });
  if (!existing) throw new Error("Support queue not found");

  const queue = await prisma.$transaction(async (tx) => {
    if (input.isDefault) {
      await tx.supportQueue.updateMany({
        where: { companyId: existing.companyId, isDefault: true, id: { not: queueId } },
        data: { isDefault: false },
      });
    }
    return tx.supportQueue.update({
      where: { id: queueId },
      data: {
        ...(input.code !== undefined ? { code: normalizeCode(input.code || "") } : {}),
        ...(input.name !== undefined ? { name: String(input.name || "").trim() } : {}),
        ...(input.description !== undefined
          ? { description: input.description?.trim() || null }
          : {}),
        ...(input.defaultOrgId !== undefined ? { defaultOrgId: input.defaultOrgId || null } : {}),
        ...(input.defaultOwnerId !== undefined ? { defaultOwnerId: input.defaultOwnerId || null } : {}),
        ...(input.isDefault !== undefined ? { isDefault: Boolean(input.isDefault) } : {}),
        ...(input.isActive !== undefined ? { isActive: Boolean(input.isActive) } : {}),
      },
      include: { defaultOrg: { select: { id: true, name: true } } },
    });
  });

  await invalidateSupportCache();
  return serializeSupportQueue(queue);
}

export async function deleteSupportQueue(id: string) {
  const queueId = String(id || "").trim();
  if (!queueId) throw new Error("queue id is required");
  await prisma.supportQueue.delete({ where: { id: queueId } });
  await invalidateSupportCache();
  return { success: true };
}

export async function listSupportAssignmentRules(companyId: string) {
  const normalizedCompanyId = String(companyId || "").trim();
  if (!normalizedCompanyId) throw new Error("companyId is required");
  const rows = await prisma.supportAssignmentRule.findMany({
    where: { companyId: normalizedCompanyId },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { queue: { select: { id: true, code: true, name: true } } },
  });
  return rows.map(serializeSupportAssignmentRule);
}

export async function createSupportAssignmentRule(input: {
  companyId: string;
  queueId?: string | null;
  name: string;
  code?: string | null;
  source?: SupportTicketSource | null;
  priority?: SupportTicketPriority | null;
  routeContains?: string | null;
  defaultOwnerId?: string | null;
  conditionsJson?: Prisma.InputJsonValue | null;
  sortOrder?: number | null;
  isActive?: boolean;
}) {
  const companyId = String(input.companyId || "").trim();
  const name = String(input.name || "").trim();
  const code = normalizeCode(input.code || name);
  if (!companyId) throw new Error("companyId is required");
  if (!name) throw new Error("Rule name is required");
  if (!code) throw new Error("Rule code is required");

  const rule = await prisma.supportAssignmentRule.create({
    data: {
      companyId,
      queueId: input.queueId || null,
      name,
      code,
      source: input.source || null,
      priority: input.priority || null,
      routeContains: input.routeContains?.trim() || null,
      defaultOwnerId: input.defaultOwnerId || null,
      conditionsJson: input.conditionsJson == null ? Prisma.JsonNull : input.conditionsJson,
      sortOrder: Number.isFinite(Number(input.sortOrder)) ? Number(input.sortOrder) : 100,
      isActive: input.isActive !== false,
    },
    include: { queue: { select: { id: true, code: true, name: true } } },
  });
  await invalidateSupportCache();
  return serializeSupportAssignmentRule(rule);
}

export async function updateSupportAssignmentRule(id: string, input: Partial<{
  queueId: string | null;
  name: string;
  code: string | null;
  source: SupportTicketSource | null;
  priority: SupportTicketPriority | null;
  routeContains: string | null;
  defaultOwnerId: string | null;
  conditionsJson: Prisma.InputJsonValue | null;
  sortOrder: number;
  isActive: boolean;
}>) {
  const ruleId = String(id || "").trim();
  if (!ruleId) throw new Error("rule id is required");
  const rule = await prisma.supportAssignmentRule.update({
    where: { id: ruleId },
    data: {
      ...(input.queueId !== undefined ? { queueId: input.queueId || null } : {}),
      ...(input.name !== undefined ? { name: String(input.name || "").trim() } : {}),
      ...(input.code !== undefined ? { code: normalizeCode(input.code || "") } : {}),
      ...(input.source !== undefined ? { source: input.source || null } : {}),
      ...(input.priority !== undefined ? { priority: input.priority || null } : {}),
      ...(input.routeContains !== undefined
        ? { routeContains: input.routeContains?.trim() || null }
        : {}),
      ...(input.defaultOwnerId !== undefined ? { defaultOwnerId: input.defaultOwnerId || null } : {}),
      ...(input.conditionsJson !== undefined
        ? { conditionsJson: input.conditionsJson == null ? Prisma.JsonNull : input.conditionsJson }
        : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: Number(input.sortOrder) || 100 } : {}),
      ...(input.isActive !== undefined ? { isActive: Boolean(input.isActive) } : {}),
    },
    include: { queue: { select: { id: true, code: true, name: true } } },
  });
  await invalidateSupportCache();
  return serializeSupportAssignmentRule(rule);
}

export async function deleteSupportAssignmentRule(id: string) {
  const ruleId = String(id || "").trim();
  if (!ruleId) throw new Error("rule id is required");
  await prisma.supportAssignmentRule.delete({ where: { id: ruleId } });
  await invalidateSupportCache();
  return { success: true };
}

async function resolveSupportAssignment(args: {
  companyId?: string | null;
  source: SupportTicketSource;
  priority: SupportTicketPriority;
  routeSnapshot?: string | null;
  sourceKey?: string | null;
  routingKey?: string | null;
  title?: string | null;
  explicitOwnerId?: string | null;
  explicitOwnerProvided: boolean;
}) {
  const companyId = String(args.companyId || "").trim();
  if (!companyId) {
    return {
      queueId: null,
      ownerOrgId: null,
      assignedOrgId: null,
      ownerId: args.explicitOwnerProvided ? args.explicitOwnerId ?? null : null,
      assignmentSource: "none",
    };
  }

  const route = String(args.routeSnapshot || "").toLowerCase();
  const rules = await prisma.supportAssignmentRule.findMany({
    where: { companyId, isActive: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: { queue: true },
    take: 100,
  });

  const matchedRule = rules.find((rule) => {
    if (rule.source && rule.source !== args.source) return false;
    if (rule.priority && rule.priority !== args.priority) return false;
    const routeNeedle = String(rule.routeContains || "").trim().toLowerCase();
    if (routeNeedle && !route.includes(routeNeedle)) return false;
    if (
      !ruleConditionsMatch(rule.conditionsJson, {
        routingKey: args.routingKey,
        sourceKey: args.sourceKey,
        title: args.title,
      })
    ) {
      return false;
    }
    return true;
  });

  const fallbackQueue = matchedRule?.queue
    ?? await prisma.supportQueue.findFirst({
      where: { companyId, isActive: true, isDefault: true },
      orderBy: [{ createdAt: "asc" }],
    })
    ?? await prisma.supportQueue.findFirst({
      where: { companyId, isActive: true },
      orderBy: [{ createdAt: "asc" }],
    });

  const ownerId = args.explicitOwnerProvided
    ? args.explicitOwnerId ?? null
    : matchedRule?.defaultOwnerId || fallbackQueue?.defaultOwnerId || null;

  return {
    queueId: fallbackQueue?.id ?? null,
    ownerOrgId: companyId,
    assignedOrgId: fallbackQueue?.defaultOrgId ?? null,
    ownerId,
    assignmentSource: matchedRule ? "rule" : fallbackQueue ? "default_queue" : "company",
    assignmentRuleId: matchedRule?.id ?? null,
  };
}

async function notifySupportUser(input: {
  userId?: string | null;
  ticketId: string;
  ticketNumber?: string | null;
  title: string;
  body: string;
  orderId?: string | null;
  reason: string;
}) {
  const userId = String(input.userId || "").trim();
  if (!userId) return;
  await createUserNotification({
    userId,
    type: NotificationType.support,
    title: input.title,
    body: input.body,
    orderId: input.orderId ?? null,
    data: {
      ticketId: input.ticketId,
      ticketNumber: input.ticketNumber ?? null,
      reason: input.reason,
    },
  }).catch((err: any) => {
    console.error(`[support] notification failed: ${err?.message || "unknown"}`);
  });
}

async function findEligibleSupportAssignee(
  userId: string,
  companyId: string | null,
  client: Pick<typeof prisma, "user"> = prisma,
) {
  if (!userId || !companyId) return null;
  return client.user.findFirst({
    where: {
      id: userId,
      memberships: {
        some: {
          companyId,
          status: "active",
          roles: {
            some: {
              role: {
                rolePermissions: {
                  some: { permission: { key: "support.update" } },
                },
              },
            },
          },
        },
      },
    },
    select: { id: true, name: true, email: true },
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
  const priority = input.priority || SupportTicketPriority.normal;
  const source = input.source || SupportTicketSource.manager;
  const status = input.status || SupportTicketStatus.open;
  const sourceKey = String(input.sourceKey || "").trim() || null;
  const routingKey = String(input.routingKey || "").trim() || null;
  const routeSnapshot = buildRoute(order);
  const companyId = String(input.companyId || order?.ownerOrgId || actorCompanyId(actor) || "").trim() || null;
  const assignment = await resolveSupportAssignment({
    companyId,
    source,
    priority,
    routeSnapshot,
    sourceKey,
    routingKey,
    title,
    explicitOwnerId: input.ownerId ?? null,
    explicitOwnerProvided: input.ownerId !== undefined,
  });
  const assignedOwner = assignment.ownerId
    ? await findEligibleSupportAssignee(assignment.ownerId, companyId)
    : null;
  if (input.ownerId && !assignedOwner) {
    const err = new Error("Selected user is not an active support operator for this company") as Error & {
      statusCode: number;
    };
    err.statusCode = 400;
    throw err;
  }
  const sla = await resolveSupportSla({
    companyId,
    queueId: assignment.queueId,
    priority,
    from: now,
  });

  if (sourceKey) {
    const existing = await prisma.supportTicket.findUnique({
      where: { sourceKey },
          select: {
            ...ticketDetailSelect,
        messages: { orderBy: { createdAt: "asc" }, take: 100 },
        notes: { orderBy: { createdAt: "asc" }, take: 100 },
        events: { orderBy: { createdAt: "asc" }, take: 120 },
      },
    });
    // A source key identifies one external/system event for its entire lifetime.
    // Returning an already resolved or archived ticket keeps automated retries
    // idempotent and avoids violating the unique sourceKey constraint.
    if (existing) {
      return serializeTicket(existing);
    }
  }

  if (order?.id && !sourceKey) {
    const existingForOrder = await prisma.supportTicket.findFirst({
      where: {
        orderId: order.id,
        archivedAt: null,
        status: { not: SupportTicketStatus.resolved },
      },
      select: ticketListSelect,
      orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
    });

    if (existingForOrder) {
      const merged = await prisma.$transaction(async (tx) => {
        const owner = input.ownerId ? assignedOwner : null;
        const shouldChangeOwner = input.ownerId !== undefined;
        const mergedSummary = input.summary?.trim() || title;
        const mergedStatus =
          input.status === SupportTicketStatus.escalated
            ? SupportTicketStatus.escalated
            : existingForOrder.status;
        const mergedPriority = strongestPriority(existingForOrder.priority, input.priority);
        const mergedSla =
          mergedPriority !== existingForOrder.priority || !existingForOrder.slaDueAt
            ? await resolveSupportSla({
                companyId,
                queueId: existingForOrder.queueId,
                priority: mergedPriority,
                from: now,
              })
            : null;

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
            ...(mergedSla
              ? { slaDueAt: mergedSla.dueAt, slaPercent: 100 }
              : {}),
          },
          select: ticketListSelect,
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
              source,
              sourceKey,
              routingKey,
              requestedPriority: priority,
              slaPolicyId: mergedSla?.policyId ?? null,
              slaTargetMinutes: mergedSla?.targetMinutes ?? null,
              summary: input.summary?.trim() || null,
            },
          },
        });
        await enqueueSupportTicketChangedTx(tx, {
          ticketId: ticket.id,
          reason: "ticket_updated",
          actor,
        payload: {
            status: mergedStatus,
            priority: mergedPriority,
            source,
            slaPolicyId: mergedSla?.policyId ?? null,
          },
        });

        return ticket;
      });

      scheduleSupportRefresh("ticket_updated", merged.id);
      return loadSerializedTicketFresh(merged.id);
    }
  }

  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      const ticketNumber = await getNextTicketNumber(tx);
      const ticket = await tx.supportTicket.create({
      data: {
        ticketNumber,
        sourceKey,
        orderId: order?.id ?? null,
        title,
        summary: input.summary?.trim() || null,
        priority,
        status,
        source,
        customerUserId: order?.customerId ?? null,
        customerEntityId: order?.customerEntityId ?? null,
        driverId: order?.assignedDriverId ?? null,
        warehouseId: order?.currentWarehouseId ?? null,
        ownerOrgId: assignment.ownerOrgId,
        assignedOrgId: assignment.assignedOrgId,
        queueId: assignment.queueId,
        ownerId: assignedOwner?.id ?? null,
        ownerName: assignedOwner?.name || assignedOwner?.email || null,
        customerName: order?.customerEntity?.name || order?.customer?.name || null,
        companyName: order?.customerEntity?.name || order?.customer?.email || null,
        routeSnapshot,
        driverName: order?.assignedDriver?.name || null,
        driverPhone: order?.assignedDriver?.email || null,
        warehouseLabel: order?.currentWarehouse?.name || null,
        lastMessage: input.summary?.trim() || title,
        lastReplyBy: getAuthorType(actor),
        slaPercent: 100,
        slaDueAt: sla.dueAt,
        lastActivityAt: now,
      },
      select: ticketListSelect,
    });
      await tx.supportTicketEvent.create({
        data: {
          ticketId: ticket.id,
          eventType: SupportTicketEventType.created,
          actorId: actorId(actor),
          actorName: actorName(actor),
          body: "Ticket created",
          metadata: {
            source,
            queueId: assignment.queueId,
            assignedOrgId: assignment.assignedOrgId,
            sourceKey,
            routingKey,
            assignmentSource: assignment.assignmentSource,
            assignmentRuleId: assignment.assignmentRuleId ?? null,
            slaPolicyId: sla.policyId,
            slaTargetMinutes: sla.targetMinutes,
          },
        },
      });
      await enqueueSupportTicketChangedTx(tx, {
        ticketId: ticket.id,
        reason: "ticket_created",
        actor,
        payload: {
          status: ticket.status,
          priority: ticket.priority,
          source,
          queueId: assignment.queueId,
        },
      });
      return ticket;
    });
  } catch (err) {
    if (
      sourceKey &&
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const existing = await prisma.supportTicket.findUnique({
        where: { sourceKey },
        select: {
          ...ticketDetailSelect,
          messages: { orderBy: { createdAt: "asc" }, take: 100 },
          notes: { orderBy: { createdAt: "asc" }, take: 100 },
          events: { orderBy: { createdAt: "asc" }, take: 120 },
        },
      });
      if (existing) return serializeTicket(existing);
    }
    throw err;
  }

  scheduleSupportRefresh("ticket_created", created.id);
  void notifySupportUser({
    userId: created.ownerId,
    ticketId: created.id,
    ticketNumber: created.ticketNumber,
    title: `New support ticket ${created.ticketNumber}`,
    body: created.title,
    orderId: created.orderId,
    reason: "ticket_created",
  });
  return serializeTicket(created);
}

export async function listSupportAssignees(actor: Actor): Promise<SupportAssignee[]> {
  const companyId = actorCompanyId(actor);
  if (!companyId) return [];

  const users = await prisma.user.findMany({
    where: {
      memberships: {
        some: {
          companyId,
          status: "active",
          roles: {
            some: {
              role: {
                rolePermissions: {
                  some: {
                    permission: { key: "support.update" },
                  },
                },
              },
            },
          },
        },
      },
    },
    orderBy: [{ name: "asc" }, { email: "asc" }],
    select: { id: true, name: true, email: true },
    distinct: ["id"],
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
      select: ticketListSelect,
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
    await enqueueSupportTicketChangedTx(tx, {
      ticketId,
      reason: "ticket_updated",
      actor,
      payload: { status },
    });
    return ticket;
  });

  scheduleSupportRefresh("ticket_updated", ticketId);
  void notifySupportUser({
    userId: updated.ownerId,
    ticketId: updated.id,
    ticketNumber: updated.ticketNumber,
    title: `Support ticket ${updated.ticketNumber} ${status}`,
    body: updated.title,
    orderId: updated.orderId,
    reason: status === SupportTicketStatus.escalated ? "ticket_escalated" : "status_changed",
  });
  return serializeTicket(updated);
}

export async function assignSupportTicket(ticketId: string, ownerId: string | null, actor: Actor) {
  const updated = await prisma.$transaction(async (tx) => {
    const owner = ownerId
      ? await findEligibleSupportAssignee(ownerId, actorCompanyId(actor), tx as typeof prisma)
      : null;
    if (ownerId && !owner) {
      const err = new Error("Selected user is not an active support operator for this company") as Error & {
        statusCode: number;
      };
      err.statusCode = 400;
      throw err;
    }
    const ticket = await tx.supportTicket.update({
      where: { id: ticketId },
      data: {
        ownerId: owner?.id ?? null,
        ownerName: owner?.name || owner?.email || null,
        lastActivityAt: new Date(),
      },
      select: ticketListSelect,
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
    await enqueueSupportTicketChangedTx(tx, {
      ticketId,
      reason: "ticket_updated",
      actor,
      payload: { ownerId },
    });
    return ticket;
  });

  scheduleSupportRefresh("ticket_updated", ticketId);
  void notifySupportUser({
    userId: updated.ownerId,
    ticketId: updated.id,
    ticketNumber: updated.ticketNumber,
    title: `Support ticket assigned`,
    body: `${updated.ticketNumber}: ${updated.title}`,
    orderId: updated.orderId,
    reason: "ticket_assigned",
  });
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
    await enqueueSupportTicketChangedTx(tx, {
      ticketId,
      reason: "note_added",
      actor,
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
    await enqueueSupportTicketChangedTx(tx, {
      ticketId,
      reason: "message_added",
      actor,
      payload: { authorType },
    });
  });

  scheduleSupportRefresh("message_added", ticketId);
  const ticket = await loadSerializedTicketFresh(ticketId);
  void notifySupportUser({
    userId: ticket?.ownerId,
    ticketId,
    ticketNumber: ticket?.ticketNumber,
    title: `New support reply`,
    body: ticket?.title || text,
    orderId: ticket?.orderId,
    reason: "message_added",
  });
  return ticket;
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

