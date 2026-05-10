import { Request, Response } from "express";
import {
  SupportTicketPriority,
  SupportTicketSource,
  SupportTicketStatus,
} from "@prisma/client";
import {
  addSupportTicketMessage,
  addSupportTicketNote,
  assignSupportTicket,
  createSupportTicket,
  getSupportTicket,
  listSupportAssignees,
  listSupportTickets,
  updateSupportTicketStatus,
} from "./supportService";
import { subscribeSupportRefresh } from "./supportRealtime";

function actorFromRequest(req: Request) {
  return {
    id: req.user?.id || "",
    role: req.user?.role,
    name: req.user?.name,
    email: req.user?.email,
  };
}

function asEnumValue<T extends Record<string, string>>(enumObj: T, value: unknown, fallback: T[keyof T]) {
  const raw = String(value || "").trim();
  return Object.values(enumObj).includes(raw) ? (raw as T[keyof T]) : fallback;
}

function asOptionalString(value: unknown) {
  const raw = String(value ?? "").trim();
  return raw || undefined;
}

function asNullableString(value: unknown) {
  if (value === null) return null;
  const raw = String(value ?? "").trim();
  return raw || undefined;
}

export async function listSupportTicketsController(req: Request, res: Response) {
  const startedAt = Date.now();
  try {
    const limit = Number(req.query.limit);
    const args = {
      status: asOptionalString(req.query.status),
      priority: asOptionalString(req.query.priority),
      source: asOptionalString(req.query.source),
      owner: (asOptionalString(req.query.owner) as any) || "mine",
      q: asOptionalString(req.query.q),
      cursor: asOptionalString(req.query.cursor),
      limit: Number.isFinite(limit) ? limit : undefined,
      includeArchived: String(req.query.includeArchived || "") === "true",
      actor: actorFromRequest(req),
    };
    const work = listSupportTickets(args).catch((err) => {
      console.error(`[support] list background load failed: ${err?.message || "unknown"}`);
      throw err;
    });
    const timeoutMs = Math.max(250, Number(process.env.SUPPORT_LIST_FAST_TIMEOUT_MS || 1500));
    const result = await Promise.race([
      work,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
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
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Failed to load support tickets" });
  }
}

export async function getSupportTicketController(req: Request, res: Response) {
  const startedAt = Date.now();
  try {
    const id = String(req.params.id || "").trim();
    const result = await getSupportTicket(id);
    res.setHeader("X-Support-Cache", result.cacheHit ? "HIT" : "MISS");
    res.setHeader("X-Support-Time-Ms", String(Date.now() - startedAt));
    if (!result.payload) return res.status(404).json({ error: "Support ticket not found" });
    return res.json(result.payload);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Failed to load support ticket" });
  }
}

export async function createSupportTicketController(req: Request, res: Response) {
  try {
    const body = req.body || {};
    const ticket = await createSupportTicket(
      {
        orderId: asNullableString(body.orderId) ?? null,
        orderNumber: asNullableString(body.orderNumber) ?? null,
        title: String(body.title || "").trim(),
        summary: asNullableString(body.summary) ?? null,
        priority: asEnumValue(SupportTicketPriority, body.priority, SupportTicketPriority.normal),
        source: asEnumValue(SupportTicketSource, body.source, SupportTicketSource.manager),
        status: asEnumValue(SupportTicketStatus, body.status, SupportTicketStatus.open),
        ownerId: body.ownerId === null ? null : asOptionalString(body.ownerId),
        sourceKey: asNullableString(body.sourceKey) ?? null,
      },
      actorFromRequest(req),
    );
    return res.status(201).json(ticket);
  } catch (err: any) {
    const status = String(err?.message || "").includes("required") ? 400 : 500;
    return res.status(status).json({ error: err?.message || "Failed to create support ticket" });
  }
}

export async function listSupportAssigneesController(_req: Request, res: Response) {
  try {
    const assignees = await listSupportAssignees();
    return res.json({ items: assignees });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Failed to load support assignees" });
  }
}

export async function updateSupportTicketStatusController(req: Request, res: Response) {
  try {
    const status = asEnumValue(SupportTicketStatus, req.body?.status, SupportTicketStatus.open);
    const ticket = await updateSupportTicketStatus(String(req.params.id), status, actorFromRequest(req));
    return res.json(ticket);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Failed to update support ticket status" });
  }
}

export async function assignSupportTicketController(req: Request, res: Response) {
  try {
    const ownerId = req.body?.ownerId === null ? null : asOptionalString(req.body?.ownerId) || req.user?.id || null;
    const ticket = await assignSupportTicket(String(req.params.id), ownerId, actorFromRequest(req));
    return res.json(ticket);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Failed to assign support ticket" });
  }
}

export async function addSupportTicketNoteController(req: Request, res: Response) {
  try {
    const ticket = await addSupportTicketNote(String(req.params.id), String(req.body?.body || ""), actorFromRequest(req));
    return res.status(201).json(ticket);
  } catch (err: any) {
    const status = String(err?.message || "").includes("required") ? 400 : 500;
    return res.status(status).json({ error: err?.message || "Failed to add support note" });
  }
}

export async function addSupportTicketMessageController(req: Request, res: Response) {
  try {
    const ticket = await addSupportTicketMessage(String(req.params.id), String(req.body?.body || ""), actorFromRequest(req));
    return res.status(201).json(ticket);
  } catch (err: any) {
    const status = String(err?.message || "").includes("required") ? 400 : 500;
    return res.status(status).json({ error: err?.message || "Failed to add support message" });
  }
}

export async function escalateSupportTicketController(req: Request, res: Response) {
  try {
    const ticket = await updateSupportTicketStatus(
      String(req.params.id),
      SupportTicketStatus.escalated,
      actorFromRequest(req),
    );
    return res.json(ticket);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Failed to escalate support ticket" });
  }
}

export async function streamSupportController(req: Request, res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let closed = false;
  const send = (event: string, payload: unknown) => {
    if (closed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send("ready", { connectedAt: new Date().toISOString() });
  const heartbeat = setInterval(() => {
    if (!closed) res.write(`: ping ${Date.now()}\n\n`);
  }, Math.max(10_000, Number(process.env.SUPPORT_STREAM_HEARTBEAT_MS || 25_000)));

  const unsubscribe = subscribeSupportRefresh((event) => {
    send("support-refresh", event);
  });

  req.on("close", () => {
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  });
}
