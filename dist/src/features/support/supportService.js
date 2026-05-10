"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listSupportTickets = listSupportTickets;
exports.getSupportTicket = getSupportTicket;
exports.createSupportTicket = createSupportTicket;
exports.listSupportAssignees = listSupportAssignees;
exports.updateSupportTicketStatus = updateSupportTicketStatus;
exports.assignSupportTicket = assignSupportTicket;
exports.addSupportTicketNote = addSupportTicketNote;
exports.addSupportTicketMessage = addSupportTicketMessage;
exports.archiveResolvedSupportTickets = archiveResolvedSupportTickets;
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const client_1 = require("@prisma/client");
const supportCache_1 = require("./supportCache");
const supportRealtime_1 = require("./supportRealtime");
function scheduleSupportRefresh(reason, ticketId) {
    void (0, supportCache_1.invalidateSupportCache)(ticketId).catch((err) => {
        console.error(`[support] async cache invalidation failed: ${err?.message || "unknown"}`);
    });
    void (0, supportRealtime_1.publishSupportRefresh)(reason, { ticketId }).catch((err) => {
        console.error(`[support] async refresh publish failed: ${err?.message || "unknown"}`);
    });
}
function normalizeLimit(value) {
    if (!Number.isFinite(value || 0))
        return 30;
    return Math.min(80, Math.max(10, Math.floor(Number(value))));
}
function isEnumValue(enumObj, value) {
    return Boolean(value && Object.values(enumObj).includes(value));
}
function encodeCursor(input) {
    return Buffer.from(`${input.lastActivityAt.toISOString()}|${input.id}`, "utf8").toString("base64url");
}
function decodeCursor(cursor) {
    if (!cursor)
        return null;
    try {
        const [dateRaw, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
        const date = new Date(dateRaw);
        if (!id || Number.isNaN(date.getTime()))
            return null;
        return { lastActivityAt: date, id };
    }
    catch {
        return null;
    }
}
async function getNextTicketNumber(tx) {
    const counter = await tx.counter.upsert({
        where: { key: "supportTicketNumber" },
        update: { value: { increment: 1 } },
        create: { key: "supportTicketNumber", value: 1 },
    });
    return `ST-${String(counter.value).padStart(6, "0")}`;
}
function actorName(actor) {
    return actor.name || actor.email || "Support";
}
function actorId(actor) {
    const id = String(actor.id || "").trim();
    return id || null;
}
function getAuthorType(actor) {
    if (actor.role === "driver")
        return client_1.SupportTicketAuthorType.driver;
    if (actor.role === "customer")
        return client_1.SupportTicketAuthorType.customer;
    return client_1.SupportTicketAuthorType.support;
}
function strongestPriority(current, next) {
    const rank = {
        normal: 1,
        high: 2,
        urgent: 3,
    };
    const currentPriority = current || client_1.SupportTicketPriority.normal;
    const nextPriority = next || client_1.SupportTicketPriority.normal;
    return rank[nextPriority] > rank[currentPriority] ? nextPriority : currentPriority;
}
function buildRoute(order) {
    const from = String(order?.pickupAddress || "").trim();
    const to = String(order?.dropoffAddress || "").trim();
    if (from && to)
        return `${from} -> ${to}`;
    return from || to || null;
}
function serializeTicket(ticket) {
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
        messages: messages.map((message) => ({
            id: message.id,
            authorType: message.authorType,
            authorId: message.authorId,
            authorName: message.authorName,
            body: message.body,
            createdAt: message.createdAt?.toISOString?.() ?? null,
        })),
        notes: notes.map((note) => ({
            id: note.id,
            actorId: note.actorId,
            actorName: note.actorName,
            body: note.body,
            createdAt: note.createdAt?.toISOString?.() ?? null,
        })),
        events: events.map((event) => ({
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
};
function buildListWhere(args) {
    const where = {};
    if (!args.includeArchived)
        where.archivedAt = null;
    if (isEnumValue(client_1.SupportTicketStatus, args.status)) {
        where.status = args.status;
    }
    if (isEnumValue(client_1.SupportTicketPriority, args.priority)) {
        where.priority = args.priority;
    }
    if (isEnumValue(client_1.SupportTicketSource, args.source)) {
        where.source = args.source;
    }
    if (args.owner === "mine") {
        where.ownerId = args.actor.id;
    }
    else if (args.owner === "unassigned") {
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
        }
        else {
            where.OR = searchOr;
        }
    }
    return where;
}
function intFromDb(value) {
    if (typeof value === "bigint")
        return Number(value);
    if (typeof value === "number")
        return value;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
async function computeSupportSummary(args) {
    const todayStart = new Date(new Date().setHours(0, 0, 0, 0));
    const now = new Date();
    const archivedFilter = args.includeArchived
        ? client_1.Prisma.empty
        : client_1.Prisma.sql `WHERE "archivedAt" IS NULL`;
    const [row] = await prismaClient_1.default.$queryRaw `
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
async function getSupportSummaryCached(args) {
    const key = JSON.stringify({ includeArchived: Boolean(args.includeArchived) });
    const result = await (0, supportCache_1.getOrComputeSupportCached)({
        namespace: "summary",
        key,
        ttlMs: Number(process.env.SUPPORT_SUMMARY_CACHE_TTL_MS || 60000),
        compute: () => computeSupportSummary(args),
    });
    return result.payload;
}
async function listSupportTickets(args) {
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
    return (0, supportCache_1.getOrComputeSupportCached)({
        namespace: "list",
        key,
        ttlMs: 20000,
        compute: async () => {
            const where = buildListWhere(args);
            const rows = await prismaClient_1.default.supportTicket.findMany({
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
async function loadSerializedTicketFresh(id) {
    const ticket = await prismaClient_1.default.supportTicket.findUnique({
        where: { id },
        select: {
            ...ticketSelect,
            messages: { orderBy: { createdAt: "asc" }, take: 100 },
            notes: { orderBy: { createdAt: "asc" }, take: 100 },
            events: { orderBy: { createdAt: "asc" }, take: 120 },
        },
    });
    if (!ticket)
        return null;
    return serializeTicket(ticket);
}
async function getSupportTicket(id) {
    return (0, supportCache_1.getOrComputeSupportCached)({
        namespace: "detail",
        key: id,
        ttlMs: 30000,
        compute: () => loadSerializedTicketFresh(id),
    });
}
function normalizeOrderNumber(value) {
    return String(value || "").trim().replace(/^#/, "");
}
async function loadOrderSnapshot(input) {
    const orderId = String(input?.orderId || "").trim();
    const orderNumber = normalizeOrderNumber(input?.orderNumber);
    if (!orderId && !orderNumber)
        return null;
    return prismaClient_1.default.order.findUnique({
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
async function createSupportTicket(input, actor) {
    const order = await loadOrderSnapshot({
        orderId: input.orderId,
        orderNumber: input.orderNumber,
    });
    const now = new Date();
    const title = String(input.title || "").trim();
    if (!title)
        throw new Error("Title is required");
    if ((input.orderId || input.orderNumber) && !order) {
        throw new Error("Order not found");
    }
    const sourceKey = String(input.sourceKey || "").trim() || null;
    if (sourceKey) {
        const existing = await prismaClient_1.default.supportTicket.findUnique({
            where: { sourceKey },
            select: {
                ...ticketSelect,
                messages: { orderBy: { createdAt: "asc" }, take: 100 },
                notes: { orderBy: { createdAt: "asc" }, take: 100 },
                events: { orderBy: { createdAt: "asc" }, take: 120 },
            },
        });
        if (existing && !existing.archivedAt && existing.status !== client_1.SupportTicketStatus.resolved) {
            return serializeTicket(existing);
        }
    }
    if (order?.id) {
        const existingForOrder = await prismaClient_1.default.supportTicket.findFirst({
            where: {
                orderId: order.id,
                archivedAt: null,
                status: { not: client_1.SupportTicketStatus.resolved },
            },
            select: ticketSelect,
            orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
        });
        if (existingForOrder) {
            const merged = await prismaClient_1.default.$transaction(async (tx) => {
                const owner = input.ownerId
                    ? await tx.user.findUnique({
                        where: { id: input.ownerId },
                        select: { id: true, name: true, email: true },
                    })
                    : null;
                const shouldChangeOwner = input.ownerId !== undefined;
                const mergedSummary = input.summary?.trim() || title;
                const mergedStatus = input.status === client_1.SupportTicketStatus.escalated
                    ? client_1.SupportTicketStatus.escalated
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
                        eventType: mergedStatus === client_1.SupportTicketStatus.escalated
                            ? client_1.SupportTicketEventType.escalated
                            : client_1.SupportTicketEventType.message_added,
                        actorId: actorId(actor),
                        actorName: actorName(actor),
                        body: `Merged new support request: ${title}`,
                        metadata: {
                            source: input.source || client_1.SupportTicketSource.manager,
                            requestedPriority: input.priority || client_1.SupportTicketPriority.normal,
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
    const created = await prismaClient_1.default.$transaction(async (tx) => {
        const ticketNumber = await getNextTicketNumber(tx);
        const ticket = await tx.supportTicket.create({
            data: {
                ticketNumber,
                sourceKey,
                orderId: order?.id ?? null,
                title,
                summary: input.summary?.trim() || null,
                priority: input.priority || client_1.SupportTicketPriority.normal,
                status: input.status || client_1.SupportTicketStatus.open,
                source: input.source || client_1.SupportTicketSource.manager,
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
                eventType: client_1.SupportTicketEventType.created,
                actorId: actorId(actor),
                actorName: actorName(actor),
                body: "Ticket created",
                metadata: { source: input.source || client_1.SupportTicketSource.manager },
            },
        });
        return ticket;
    });
    scheduleSupportRefresh("ticket_created", created.id);
    return serializeTicket(created);
}
async function listSupportAssignees() {
    const users = await prismaClient_1.default.user.findMany({
        where: { role: client_1.AppRole.manager },
        orderBy: [{ name: "asc" }, { email: "asc" }],
        select: { id: true, name: true, email: true, role: true },
        take: 200,
    });
    return users;
}
async function updateSupportTicketStatus(ticketId, status, actor) {
    const now = new Date();
    const data = {
        status,
        lastActivityAt: now,
    };
    if (status === client_1.SupportTicketStatus.resolved)
        data.resolvedAt = now;
    if (status !== client_1.SupportTicketStatus.resolved)
        data.resolvedAt = null;
    const updated = await prismaClient_1.default.$transaction(async (tx) => {
        const ticket = await tx.supportTicket.update({
            where: { id: ticketId },
            data,
            select: ticketSelect,
        });
        await tx.supportTicketEvent.create({
            data: {
                ticketId,
                eventType: status === client_1.SupportTicketStatus.escalated
                    ? client_1.SupportTicketEventType.escalated
                    : status === client_1.SupportTicketStatus.resolved
                        ? client_1.SupportTicketEventType.resolved
                        : client_1.SupportTicketEventType.status_changed,
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
async function assignSupportTicket(ticketId, ownerId, actor) {
    const updated = await prismaClient_1.default.$transaction(async (tx) => {
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
                eventType: client_1.SupportTicketEventType.assigned,
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
async function addSupportTicketNote(ticketId, body, actor) {
    const text = body.trim();
    if (!text)
        throw new Error("Note body is required");
    await prismaClient_1.default.$transaction(async (tx) => {
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
                eventType: client_1.SupportTicketEventType.note_added,
                actorId: actorId(actor),
                actorName: actorName(actor),
                body: "Internal note added",
            },
        });
    });
    scheduleSupportRefresh("note_added", ticketId);
    return loadSerializedTicketFresh(ticketId);
}
async function addSupportTicketMessage(ticketId, body, actor) {
    const text = body.trim();
    if (!text)
        throw new Error("Message body is required");
    const authorType = getAuthorType(actor);
    await prismaClient_1.default.$transaction(async (tx) => {
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
                eventType: client_1.SupportTicketEventType.message_added,
                actorId: actorId(actor),
                actorName: actorName(actor),
                body: "Message added",
            },
        });
    });
    scheduleSupportRefresh("message_added", ticketId);
    return loadSerializedTicketFresh(ticketId);
}
async function archiveResolvedSupportTickets(days = 30) {
    const cutoff = new Date(Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000);
    const result = await prismaClient_1.default.supportTicket.updateMany({
        where: {
            status: client_1.SupportTicketStatus.resolved,
            archivedAt: null,
            resolvedAt: { lt: cutoff },
        },
        data: { archivedAt: new Date() },
    });
    if (result.count > 0) {
        await (0, supportCache_1.invalidateSupportCache)();
        await (0, supportRealtime_1.publishSupportRefresh)("ticket_archived", { keys: ["list", "summary"] });
    }
    return result.count;
}
