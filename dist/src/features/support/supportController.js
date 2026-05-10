"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listSupportTicketsController = listSupportTicketsController;
exports.getSupportTicketController = getSupportTicketController;
exports.createSupportTicketController = createSupportTicketController;
exports.listSupportAssigneesController = listSupportAssigneesController;
exports.updateSupportTicketStatusController = updateSupportTicketStatusController;
exports.assignSupportTicketController = assignSupportTicketController;
exports.addSupportTicketNoteController = addSupportTicketNoteController;
exports.addSupportTicketMessageController = addSupportTicketMessageController;
exports.escalateSupportTicketController = escalateSupportTicketController;
exports.streamSupportController = streamSupportController;
const client_1 = require("@prisma/client");
const supportService_1 = require("./supportService");
const supportRealtime_1 = require("./supportRealtime");
function actorFromRequest(req) {
    return {
        id: req.user?.id || "",
        role: req.user?.role,
        name: req.user?.name,
        email: req.user?.email,
    };
}
function asEnumValue(enumObj, value, fallback) {
    const raw = String(value || "").trim();
    return Object.values(enumObj).includes(raw) ? raw : fallback;
}
function asOptionalString(value) {
    const raw = String(value ?? "").trim();
    return raw || undefined;
}
function asNullableString(value) {
    if (value === null)
        return null;
    const raw = String(value ?? "").trim();
    return raw || undefined;
}
async function listSupportTicketsController(req, res) {
    const startedAt = Date.now();
    try {
        const limit = Number(req.query.limit);
        const args = {
            status: asOptionalString(req.query.status),
            priority: asOptionalString(req.query.priority),
            source: asOptionalString(req.query.source),
            owner: asOptionalString(req.query.owner) || "mine",
            q: asOptionalString(req.query.q),
            cursor: asOptionalString(req.query.cursor),
            limit: Number.isFinite(limit) ? limit : undefined,
            includeArchived: String(req.query.includeArchived || "") === "true",
            actor: actorFromRequest(req),
        };
        const work = (0, supportService_1.listSupportTickets)(args).catch((err) => {
            console.error(`[support] list background load failed: ${err?.message || "unknown"}`);
            throw err;
        });
        const timeoutMs = Math.max(250, Number(process.env.SUPPORT_LIST_FAST_TIMEOUT_MS || 1500));
        const result = await Promise.race([
            work,
            new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
        ]);
        if (!result) {
            res.setHeader("X-Support-Cache", "PARTIAL");
            res.setHeader("X-Support-Time-Ms", String(Date.now() - startedAt));
            return res.json({
                items: [],
                hasMore: false,
                nextCursor: null,
                summary: {
                    open: 0,
                    escalated: 0,
                    waitingCustomer: 0,
                    waitingDriver: 0,
                    waiting: 0,
                    resolvedToday: 0,
                    slaRisk: 0,
                },
                isPartial: true,
            });
        }
        res.setHeader("X-Support-Cache", result.cacheHit ? "HIT" : "MISS");
        res.setHeader("X-Support-Time-Ms", String(Date.now() - startedAt));
        return res.json(result.payload);
    }
    catch (err) {
        return res.status(500).json({ error: err?.message || "Failed to load support tickets" });
    }
}
async function getSupportTicketController(req, res) {
    const startedAt = Date.now();
    try {
        const id = String(req.params.id || "").trim();
        const result = await (0, supportService_1.getSupportTicket)(id);
        res.setHeader("X-Support-Cache", result.cacheHit ? "HIT" : "MISS");
        res.setHeader("X-Support-Time-Ms", String(Date.now() - startedAt));
        if (!result.payload)
            return res.status(404).json({ error: "Support ticket not found" });
        return res.json(result.payload);
    }
    catch (err) {
        return res.status(500).json({ error: err?.message || "Failed to load support ticket" });
    }
}
async function createSupportTicketController(req, res) {
    try {
        const body = req.body || {};
        const ticket = await (0, supportService_1.createSupportTicket)({
            orderId: asNullableString(body.orderId) ?? null,
            orderNumber: asNullableString(body.orderNumber) ?? null,
            title: String(body.title || "").trim(),
            summary: asNullableString(body.summary) ?? null,
            priority: asEnumValue(client_1.SupportTicketPriority, body.priority, client_1.SupportTicketPriority.normal),
            source: asEnumValue(client_1.SupportTicketSource, body.source, client_1.SupportTicketSource.manager),
            status: asEnumValue(client_1.SupportTicketStatus, body.status, client_1.SupportTicketStatus.open),
            ownerId: body.ownerId === null ? null : asOptionalString(body.ownerId),
            sourceKey: asNullableString(body.sourceKey) ?? null,
        }, actorFromRequest(req));
        return res.status(201).json(ticket);
    }
    catch (err) {
        const status = String(err?.message || "").includes("required") ? 400 : 500;
        return res.status(status).json({ error: err?.message || "Failed to create support ticket" });
    }
}
async function listSupportAssigneesController(_req, res) {
    try {
        const assignees = await (0, supportService_1.listSupportAssignees)();
        return res.json({ items: assignees });
    }
    catch (err) {
        return res.status(500).json({ error: err?.message || "Failed to load support assignees" });
    }
}
async function updateSupportTicketStatusController(req, res) {
    try {
        const status = asEnumValue(client_1.SupportTicketStatus, req.body?.status, client_1.SupportTicketStatus.open);
        const ticket = await (0, supportService_1.updateSupportTicketStatus)(String(req.params.id), status, actorFromRequest(req));
        return res.json(ticket);
    }
    catch (err) {
        return res.status(500).json({ error: err?.message || "Failed to update support ticket status" });
    }
}
async function assignSupportTicketController(req, res) {
    try {
        const ownerId = req.body?.ownerId === null ? null : asOptionalString(req.body?.ownerId) || req.user?.id || null;
        const ticket = await (0, supportService_1.assignSupportTicket)(String(req.params.id), ownerId, actorFromRequest(req));
        return res.json(ticket);
    }
    catch (err) {
        return res.status(500).json({ error: err?.message || "Failed to assign support ticket" });
    }
}
async function addSupportTicketNoteController(req, res) {
    try {
        const ticket = await (0, supportService_1.addSupportTicketNote)(String(req.params.id), String(req.body?.body || ""), actorFromRequest(req));
        return res.status(201).json(ticket);
    }
    catch (err) {
        const status = String(err?.message || "").includes("required") ? 400 : 500;
        return res.status(status).json({ error: err?.message || "Failed to add support note" });
    }
}
async function addSupportTicketMessageController(req, res) {
    try {
        const ticket = await (0, supportService_1.addSupportTicketMessage)(String(req.params.id), String(req.body?.body || ""), actorFromRequest(req));
        return res.status(201).json(ticket);
    }
    catch (err) {
        const status = String(err?.message || "").includes("required") ? 400 : 500;
        return res.status(status).json({ error: err?.message || "Failed to add support message" });
    }
}
async function escalateSupportTicketController(req, res) {
    try {
        const ticket = await (0, supportService_1.updateSupportTicketStatus)(String(req.params.id), client_1.SupportTicketStatus.escalated, actorFromRequest(req));
        return res.json(ticket);
    }
    catch (err) {
        return res.status(500).json({ error: err?.message || "Failed to escalate support ticket" });
    }
}
async function streamSupportController(req, res) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    let closed = false;
    const send = (event, payload) => {
        if (closed)
            return;
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    send("ready", { connectedAt: new Date().toISOString() });
    const heartbeat = setInterval(() => {
        if (!closed)
            res.write(`: ping ${Date.now()}\n\n`);
    }, Math.max(10000, Number(process.env.SUPPORT_STREAM_HEARTBEAT_MS || 25000)));
    const unsubscribe = (0, supportRealtime_1.subscribeSupportRefresh)((event) => {
        send("support-refresh", event);
    });
    req.on("close", () => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
    });
}
