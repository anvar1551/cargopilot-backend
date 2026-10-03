import prisma from "../../../config/prismaClient";
import { maintainOwnedSupportTickets } from "./supportMaintenance";
import { Prisma, NotificationType, SupportTicketAuthorType, SupportTicketEventType, SupportTicketPriority, SupportTicketSource, SupportTicketStatus } from "@prisma/client";
import { requireSupportAccess, rejectSupportOwnership, supportAssignee, lockSupportTicket, matchesProspectiveSupportScope, safeSupportOrderScope, supportError, type SupportActor as Actor } from "./supportAccess";
import { buildOrderScopeWhere } from "../../identity-access/access-control";
import { requireCustomerAccess } from "../../customers-core/application/customerAccess";
import { requireWarehouseAccess } from "../../warehouse-core/application/warehouseAccess";
import { enqueueCargoPilotDomainEventTx } from "../../analytics-core/infrastructure/analyticsOutbox";

export type ListSupportTicketsArgs = { status?: string | null; priority?: string | null; source?: string | null;
 owner?: "mine" | "unassigned" | "all" | null; q?: string | null; cursor?: string | null; limit?: number | null;
 includeArchived?: boolean; actor: Actor; scopeWhere?: Prisma.SupportTicketWhereInput | null };
export type CreateSupportTicketInput = { orderId?: string | null; orderNumber?: string | null; title: string; summary?: string | null;
 priority?: SupportTicketPriority; ownerId?: string | null };
export type SupportAssignee = { id: string; name: string; email: string };
function actorCompanyId(actor: Actor) { return actor.companyId; }
function actorId(actor: Actor) { return actor.id; }
function actorName(actor: Actor) { return actor.name || "Support"; }
function getAuthorType(actor: Actor) { return actor.permissionCodes.includes("drivers.telemetry") ? SupportTicketAuthorType.driver : actor.customerEntityId ? SupportTicketAuthorType.customer : SupportTicketAuthorType.support; }
function normalizeLimit(value?: number | null) { return Number.isFinite(value) ? Math.min(80,Math.max(10,Math.floor(Number(value)))) : 30; }
function normalizeSearchQuery(value?: string | null) { const q=String(value || "").trim().slice(0,80); return q.length<2?"":q; }
function isEnumValue<T extends Record<string,string>>(e:T,v?: string | null): v is T[keyof T] { return !!v && Object.values(e).includes(v); }
function encodeCursor(v:{lastActivityAt:Date;id:string}) { return Buffer.from(v.lastActivityAt.toISOString()+"|"+v.id).toString("base64url"); }
function decodeCursor(v?:string|null) { if(!v)return null; try {const [date,id]=Buffer.from(v,"base64url").toString().split("|"); const lastActivityAt=new Date(date); return id && !Number.isNaN(lastActivityAt.getTime()) ? {lastActivityAt,id}:null;} catch{return null;} }
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


async function supportEvent(tx: any, ticket: any, actor: Actor, eventType: SupportTicketEventType, body: string) {
  await tx.supportTicketEvent.create({ data: { ticketId: ticket.id, eventType, actorId: actor.id, actorName: actorName(actor), body } });
  await enqueueCargoPilotDomainEventTx(tx, { type: "support_ticket_changed",
    tenantScope: `tenant:${ticket.tenantId}:company:${ticket.ownerOrgId}`, entityId: ticket.id,
    payload: { reason: eventType === "message_added" ? "message_added" : eventType === "note_added" ? "note_added" : eventType === "created" ? "ticket_created" : "ticket_updated" } });
  if (ticket.ownerId) {
    const recipient = await supportAssignee(ticket.ownerId, actor, ticket, tx);
    if (recipient.membershipId !== ticket.ownerCompanyMembershipId) throw supportError("Conflicting support recipient context");
    await tx.userNotification.create({ data: { userId: ticket.ownerId, tenantId: ticket.tenantId, companyId: ticket.ownerOrgId,
      companyMembershipId: recipient.membershipId, type: NotificationType.support,
      title: `Support ticket ${ticket.ticketNumber}`, body: ticket.title, orderId: ticket.orderId,
      data: { ticketId: ticket.id, reason: eventType } } });
  }
}

export async function getSupportSummary(args: { includeArchived?: boolean; actor: Actor; scopeWhere?: Prisma.SupportTicketWhereInput | null }) {
  const access = await requireSupportAccess(args.actor);
  return computeSupportSummary({ ...args, scopeWhere: access.where });
}
export async function listSupportTickets(args: ListSupportTicketsArgs) {
  const access = await requireSupportAccess(args.actor);
  const scopedArgs = { ...args, actor: access.actor, scopeWhere: access.where };
  const limit = normalizeLimit(args.limit);
  const rows = await prisma.supportTicket.findMany({ where: buildListWhere(scopedArgs), select: ticketListSelect,
    orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }], take: limit + 1 });
  const page = rows.slice(0, limit), last = page[page.length - 1];
  return { cacheHit: false, payload: { items: page.map(serializeTicket), hasMore: rows.length > limit,
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    summary: await computeSupportSummary({ includeArchived: args.includeArchived, scopeWhere: access.where }) } };
}
export async function getSupportTicketScoped(args: { id: string; actor: Actor; scopeWhere?: Prisma.SupportTicketWhereInput | null }) {
  const access = await requireSupportAccess(args.actor);
  const ticket = await prisma.supportTicket.findFirst({ where: { AND: [{ id: args.id }, access.where] }, select: {
    ...ticketDetailSelect,
    messages: { select: { id: true, authorType: true, authorId: true, authorName: true, body: true, createdAt: true }, orderBy: { createdAt: "asc" }, take: 100 },
    ...(access.snapshot.permissionCodes.includes("support.assign") || access.snapshot.permissionCodes.includes("support.configure") ? {
      notes: { select: { id: true, actorId: true, actorName: true, body: true, createdAt: true }, orderBy: { createdAt: "asc" }, take: 100 },
      events: { select: { id: true, eventType: true, actorId: true, actorName: true, body: true, createdAt: true }, orderBy: { createdAt: "asc" }, take: 120 },
    } : {}),
  } });
  return { cacheHit: false, payload: ticket ? serializeTicket(ticket) : null };
}
export async function getSupportTicket(id: string, actor: Actor) { return getSupportTicketScoped({ id, actor }); }

async function loadOwnedOrder(input: CreateSupportTicketInput, actor: Actor) {
  const id = String(input.orderId || "").trim(), number = String(input.orderNumber || "").trim().replace(/^#/, "");
  if (!id && !number) return null;
  const scope = await buildOrderScopeWhere(actor, "shipment.view");
  const order = await prisma.order.findFirst({ where: { AND: [
    { tenantId: actor.tenantId, ownerOrgId: actor.companyId }, safeSupportOrderScope(scope),
    ...(id ? [{ id }] : []), ...(number ? [{ orderNumber: number }] : []),
  ] }, select: { id: true, tenantId: true, ownerOrgId: true, customerId: true, customerEntityId: true,
    assignedOrgId: true, assignedDriverId: true, currentWarehouseId: true, pickupAddress: true, dropoffAddress: true,
    customerEntity: { select: { name: true } }, currentWarehouse: { select: { name: true } } } });
  if (!order) throw supportError("Order not found", 404);
  if (order.customerEntityId) {
    const customer = await requireCustomerAccess(actor, "customers.read");
    if (!await prisma.customerEntity.findFirst({ where: { AND: [{ id: order.customerEntityId }, customer.customerWhere] }, select: { id: true } })) throw supportError("Customer not accessible");
  }
  if (order.currentWarehouseId) {
    const warehouse = await requireWarehouseAccess(actor, "shipment.view");
    if (!await prisma.warehouse.findFirst({ where: { AND: [{ id: order.currentWarehouseId }, warehouse.where] }, select: { id: true } })) throw supportError("Warehouse not accessible");
  }
  for (const userId of [...new Set([order.customerId, order.assignedDriverId].filter(Boolean))]) {
    const membership = await prisma.companyMembership.findUnique({ where: { userId_companyId: { userId: userId!, companyId: actor.companyId } }, select: { id: true, tenantMembershipId: true } });
    const { loadAccessSnapshot } = await import("../../identity-access/access-control");
    if (!membership?.tenantMembershipId || !await loadAccessSnapshot({ userId: userId!, membershipId: membership.id,
      companyMembershipId: membership.id, companyId: actor.companyId, tenantId: actor.tenantId,
      tenantMembershipId: membership.tenantMembershipId, requireFresh: true })) throw supportError("Order recipient context not established");
  }
  return order;
}

export async function createSupportTicket(input: CreateSupportTicketInput, actor: Actor) {
  const access = await requireSupportAccess(actor, "support.createTicket"); actor = access.actor;
  rejectSupportOwnership(input);
  const allowed = new Set(["orderId", "orderNumber", "title", "summary", "priority", "ownerId"]);
  if (Object.keys(input).some(key => !allowed.has(key))) throw supportError("Unsupported support creation field", 400);
  const title = String(input.title || "").trim();
  if (!title || title.length > 240 || (input.summary?.length ?? 0) > 4000) throw supportError("Invalid support content", 400);
  if (input.priority && !isEnumValue(SupportTicketPriority, input.priority)) throw supportError("Invalid priority", 400);
  if (input.ownerId !== undefined && !access.snapshot.permissionCodes.includes("support.assign")) throw supportError("Support assignment permission required");
  const order = await loadOwnedOrder(input, actor), now = new Date();
  const assignment = await resolveSupportAssignment({ companyId: actor.companyId, source: "manager", priority: input.priority ?? "normal",
    routeSnapshot: buildRoute(order), title, explicitOwnerId: input.ownerId, explicitOwnerProvided: input.ownerId !== undefined });
  if (assignment.assignedOrgId && assignment.assignedOrgId !== actor.companyId) throw supportError("Queue organization requires a reviewed company binding");
  if (assignment.queueId && !await prisma.supportQueue.findFirst({ where: { id: assignment.queueId, companyId: actor.companyId, isActive: true }, select: { id: true } })) throw supportError("Queue ownership conflict");
  const owner = assignment.ownerId ? await supportAssignee(assignment.ownerId, actor, { assignedOrgId: assignment.assignedOrgId }) : null;
  const prospectiveScope = matchesProspectiveSupportScope(access.objectScope, {
    ownerOrgId: actor.companyId, assignedOrgId: assignment.assignedOrgId,
    ownerId: owner?.id ?? null, customerEntityId: order?.customerEntityId ?? null,
  });
  if (!prospectiveScope) throw supportError("Support creation object scope required");
  const sla = await resolveSupportSla({ companyId: actor.companyId, queueId: assignment.queueId, priority: input.priority ?? "normal", from: now });
  const ticket = await prisma.$transaction(async tx => {
    if (order) {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id}::uuid AND "tenantId" = ${actor.tenantId}::uuid AND "ownerOrgId" = ${actor.companyId}::uuid FOR UPDATE`;
      const current = await tx.order.findFirst({ where: { id: order.id, tenantId: actor.tenantId, ownerOrgId: actor.companyId } });
      if (!current || current.customerId !== order.customerId || current.customerEntityId !== order.customerEntityId ||
        current.assignedOrgId !== order.assignedOrgId || current.assignedDriverId !== order.assignedDriverId || current.currentWarehouseId !== order.currentWarehouseId) throw supportError("Order context changed", 409);
      const existing = await tx.supportTicket.findFirst({ where: { AND: [access.where, { orderId: order.id, archivedAt: null, status: { not: "resolved" } }] }, orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }] });
      if (existing) {
        await lockSupportTicket(tx, existing.id, access);
        const mergedPriority = strongestPriority(existing.priority, input.priority);
        const mergedSla = mergedPriority !== existing.priority ? await resolveSupportSla({ companyId: actor.companyId, queueId: existing.queueId, priority: mergedPriority, from: now }) : null;
        const updated = await tx.supportTicket.update({ where: { id: existing.id, AND: [access.where] }, data: {
          priority: mergedPriority, lastMessage: input.summary?.trim() || title,
          lastReplyBy: getAuthorType(actor), lastActivityAt: now,
          ...(input.ownerId !== undefined ? { ownerId: owner?.id ?? null, ownerCompanyMembershipId: owner?.membershipId ?? null, ownerName: owner?.name ?? null } : {}),
          ...(mergedSla ? { slaDueAt: mergedSla.dueAt, slaPercent: 100 } : {}),
        } });
        await supportEvent(tx, updated, actor, "message_added", "Merged support request"); return updated;
      }
    }
    const counter = await tx.counter.upsert({ where: { key: "supportTicketNumber" }, create: { key: "supportTicketNumber", value: 1 }, update: { value: { increment: 1 } } });
    const created = await tx.supportTicket.create({ data: {
      tenantId: actor.tenantId, ownerOrgId: actor.companyId, ticketNumber: `ST-${String(counter.value).padStart(6,"0")}`,
      orderId: order?.id ?? null, title, summary: input.summary?.trim() || null, priority: input.priority ?? "normal", source: "manager", status: "open",
      customerUserId: order?.customerId ?? null, customerEntityId: order?.customerEntityId ?? null, driverId: order?.assignedDriverId ?? null,
      warehouseId: order?.currentWarehouseId ?? null, ownerId: owner?.id ?? null, ownerCompanyMembershipId: owner?.membershipId ?? null, ownerName: owner?.name ?? null,
      assignedOrgId: assignment.assignedOrgId, queueId: assignment.queueId, customerName: order?.customerEntity?.name ?? null,
      routeSnapshot: buildRoute(order), warehouseLabel: order?.currentWarehouse?.name ?? null,
      lastMessage: input.summary?.trim() || title, lastReplyBy: getAuthorType(actor), slaDueAt: sla.dueAt, lastActivityAt: now,
    } });
    await supportEvent(tx, created, actor, "created", "Ticket created"); return created;
  });
  return serializeTicket(ticket);
}

export async function listSupportAssignees(actor: Actor): Promise<SupportAssignee[]> {
  const access = await requireSupportAccess(actor);
  const candidates = await prisma.companyMembership.findMany({ where: { companyId: access.snapshot.companyId, tenantId: access.snapshot.tenantId, status: "active",
    tenantMembershipId: { not: null }, tenantMembership: { is: { tenantId: access.snapshot.tenantId, status: "active" } },
    scopes: { some: { scopeType: "company", scopeRefId: access.snapshot.companyId } },
    roles: { some: { role: { rolePermissions: { some: { permission: { key: "support.update" } } } } } },
  }, select: { user: { select: { id: true, name: true, email: true } } }, orderBy: { id: "asc" }, take: 200 });
  return candidates.map(row => ({ id: row.user.id, name: row.user.name, email: row.user.email }));
}

async function mutateTicket(ticketId: string, actor: Actor, permission: string, mutate: (tx: any, ticket: any, actor: Actor, scope: Prisma.SupportTicketWhereInput) => Promise<any>) {
  const access = await requireSupportAccess(actor, permission);
  return prisma.$transaction(async tx => {
    const ticket = await lockSupportTicket(tx, ticketId, access);
    if (ticket.archivedAt) throw supportError("Archived ticket is read-only", 409);
    return mutate(tx, ticket, access.actor, access.where);
  });
}
export async function updateSupportTicketStatus(id: string, status: SupportTicketStatus, actor: Actor) {
  if (!isEnumValue(SupportTicketStatus, status)) throw supportError("Invalid support status", 400);
  const ticket = await mutateTicket(id, actor, "support.update", async (tx, current, verified, scope) => {
    const extra = status === "resolved" ? "support.resolve" : status === "escalated" ? "support.escalate" : null;
    if (extra && !verified.permissionCodes.includes(extra)) throw supportError("Support transition permission required");
    const updated = await tx.supportTicket.update({ where: { id, AND: [scope] },
      data: { status, resolvedAt: status === "resolved" ? new Date() : null, lastActivityAt: new Date() } });
    await supportEvent(tx, updated, verified, status === "resolved" ? "resolved" : status === "escalated" ? "escalated" : "status_changed", "Support status changed"); return updated;
  }); return serializeTicket(ticket);
}
export async function assignSupportTicket(id: string, ownerId: string | null, actor: Actor) {
  const ticket = await mutateTicket(id, actor, "support.assign", async (tx, current, verified, scope) => {
    const owner = ownerId ? await supportAssignee(ownerId, verified, current, tx) : null;
    const updated = await tx.supportTicket.update({ where: { id, AND: [scope] },
      data: { ownerId: owner?.id ?? null, ownerCompanyMembershipId: owner?.membershipId ?? null, ownerName: owner?.name ?? null, lastActivityAt: new Date() } });
    await supportEvent(tx, updated, verified, "assigned", "Support assignment changed"); return updated;
  }); return serializeTicket(ticket);
}
async function appendTicketContent(id: string, body: string, actor: Actor, note: boolean) {
  const text = String(body || "").trim(); if (!text || text.length > 4000) throw supportError("Invalid support content", 400);
  await mutateTicket(id, actor, "support.update", async (tx, current, verified, scope) => {
    if (note && !verified.permissionCodes.includes("support.assign") && !verified.permissionCodes.includes("support.configure")) throw supportError("Internal support permission required");
    if (note) await tx.supportTicketNote.create({ data: { ticketId: id, actorId: verified.id, actorName: actorName(verified), body: text } });
    else await tx.supportTicketMessage.create({ data: { ticketId: id, authorId: verified.id, authorName: actorName(verified), authorType: getAuthorType(verified), body: text } });
    const updated = await tx.supportTicket.update({ where: { id, AND: [scope] },
      data: { lastActivityAt: new Date(), ...(!note ? { lastMessage: text, lastReplyBy: getAuthorType(verified) } : {}) } });
    await supportEvent(tx, updated, verified, note ? "note_added" : "message_added", note ? "Internal note added" : "Message added");
  }); return (await getSupportTicketScoped({ id, actor })).payload;
}
export async function addSupportTicketNote(id: string, body: string, actor: Actor) { return appendTicketContent(id, body, actor, true); }
export async function addSupportTicketMessage(id: string, body: string, actor: Actor) { return appendTicketContent(id, body, actor, false); }

async function configure(actor: Actor, companyId?: string) {
  const access = await requireSupportAccess(actor, "support.configure");
  if (companyId !== undefined && companyId !== access.snapshot.companyId) throw supportError("Configuration company conflict");
  if (!access.snapshot.scopes.some(s => s.scopeType === "company" && s.scopeRefId === access.snapshot.companyId)) throw supportError("Selected company configuration scope required");
  return access;
}
async function validateConfiguration(input: any, actor: Actor) {
  if (input.defaultOrgId && input.defaultOrgId !== actor.companyId) throw supportError("Organization needs a reviewed selected-company binding");
  if (input.defaultOwnerId) await supportAssignee(input.defaultOwnerId, actor);
  if (input.queueId && !await prisma.supportQueue.findFirst({ where: { id: input.queueId, companyId: actor.companyId, isActive: true }, select: { id: true } })) throw supportError("Queue not accessible", 400);
}
const configFields = {
  supportQueue: ["code","name","description","defaultOrgId","defaultOwnerId","isDefault","isActive"],
  supportAssignmentRule: ["queueId","code","name","source","priority","routeContains","defaultOwnerId","conditionsJson","sortOrder","isActive"],
};
async function configMutation(model: keyof typeof configFields, id: string | null, input: any, actor: Actor, remove = false) {
  const access = await configure(actor, input.companyId); actor = access.actor;
  if (Object.keys(input).some(key => key !== "companyId" && !configFields[model].includes(key))) throw supportError("Unsupported support configuration field", 400);
  await validateConfiguration(input, actor);
  return prisma.$transaction(async (tx: any) => {
    if (id && !await tx[model].findFirst({ where: { id, companyId: actor.companyId } })) throw supportError("Support configuration not found", 404);
    const data: any = {};
    for (const field of configFields[model]) if (input[field] !== undefined) data[field] = input[field];
    if (data.code !== undefined) data.code = normalizeCode(data.code || data.name || "");
    if (!id) {
      if (!String(data.name || "").trim()) throw supportError("Configuration name required", 400);
      data.code = normalizeCode(data.code || data.name);
    }
    if (model === "supportQueue" && data.isDefault) await tx.supportQueue.updateMany({ where: { companyId: actor.companyId, isDefault: true, ...(id ? { id: { not: id } } : {}) }, data: { isDefault: false } });
    const row = remove ? await tx[model].delete({ where: { id, companyId: actor.companyId } }) : id
      ? await tx[model].update({ where: { id, companyId: actor.companyId }, data })
      : await tx[model].create({ data: { ...data, companyId: actor.companyId } });
    await enqueueCargoPilotDomainEventTx(tx, { type: "support_ticket_changed", tenantScope: `tenant:${actor.tenantId}:company:${actor.companyId}`,
      entityId: null, companySubjectId: actor.companyId, payload: { reason: "configuration_changed" } });
    return remove ? { success: true } : model === "supportQueue" ? serializeSupportQueue(row) : serializeSupportAssignmentRule(row);
  });
}
export async function listSupportQueues(companyId: string, actor: Actor) {
  const access = await configure(actor, companyId);
  return (await prisma.supportQueue.findMany({ where: { companyId: access.snapshot.companyId }, orderBy: [{ isDefault: "desc" }, { name: "asc" }], take: 200 })).map(serializeSupportQueue);
}
export async function listSupportAssignmentRules(companyId: string, actor: Actor) {
  const access = await configure(actor, companyId);
  return (await prisma.supportAssignmentRule.findMany({ where: { companyId: access.snapshot.companyId, OR: [{ queueId: null }, { queue: { is: { companyId: access.snapshot.companyId } } }] }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], take: 200 })).map(serializeSupportAssignmentRule);
}
export async function createSupportQueue(input: any, actor: Actor) { return configMutation("supportQueue", null, input, actor); }
export async function updateSupportQueue(id: string, input: any, actor: Actor) { return configMutation("supportQueue", id, input, actor); }
export async function deleteSupportQueue(id: string, actor: Actor) { return configMutation("supportQueue", id, {}, actor, true); }
export async function createSupportAssignmentRule(input: any, actor: Actor) { return configMutation("supportAssignmentRule", null, input, actor); }
export async function updateSupportAssignmentRule(id: string, input: any, actor: Actor) { return configMutation("supportAssignmentRule", id, input, actor); }
export async function deleteSupportAssignmentRule(id: string, actor: Actor) { return configMutation("supportAssignmentRule", id, {}, actor, true); }

export async function archiveResolvedSupportTickets(days = 30) { return maintainOwnedSupportTickets("archive", days); }
