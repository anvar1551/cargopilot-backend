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
import {
  replaySupportRefreshFromRedis,
  replaySupportRefreshSince,
  subscribeSupportRefresh,
} from "./supportRealtime";
import { recordSseConnected, recordSseDisconnected } from "../observability/opsMetrics";

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
    const result = await listSupportTickets(args);
    res.setHeader("X-Support-Cache", result.cacheHit ? "HIT" : "MISS");
    res.setHeader("X-Support-Time-Ms", String(Date.now() - startedAt));
    return res.json(result.payload);
  } catch (err: any) {
    console.error(`[support] list tickets failed: ${err?.message || "unknown"}`);
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
    console.error(`[support] get ticket failed: ${err?.message || "unknown"}`);
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

  const clientKey = `${req.user?.id || "anon"}:${req.ip || "ip"}`;
  const lastEventId = String(req.header("last-event-id") || req.header("Last-Event-ID") || "").trim();
  recordSseConnected({ stream: "support", clientKey });
  let closed = false;
  const send = (event: string, payload: unknown, id?: string | null) => {
    if (closed) return;
    if (id) res.write(`id: ${id}\n`);
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send("ready", { connectedAt: new Date().toISOString(), resumedFrom: lastEventId || null });
  const redisReplayEvents = await replaySupportRefreshFromRedis({
    lastEventId,
    limit: Number(process.env.SUPPORT_STREAM_REPLAY_MAX_EVENTS || 200),
  });
  const replayEvents = redisReplayEvents.length
    ? redisReplayEvents
    : replaySupportRefreshSince(lastEventId);
  const replayLimit = Math.max(10, Number(process.env.SUPPORT_STREAM_REPLAY_MAX_EVENTS || 200));
  const replaySlice = replayEvents.slice(-replayLimit);
  replaySlice.forEach((event) => {
    send("support-refresh", event, event.id);
  });
  if (replayEvents.length > replaySlice.length) {
    send("support-replay-truncated", {
      skipped: replayEvents.length - replaySlice.length,
      delivered: replaySlice.length,
    });
  }
  const heartbeat = setInterval(() => {
    if (!closed) res.write(`: ping ${Date.now()}\n\n`);
  }, Math.max(10_000, Number(process.env.SUPPORT_STREAM_HEARTBEAT_MS || 25_000)));

  const unsubscribe = subscribeSupportRefresh((event) => {
    send("support-refresh", event, event.id);
  });

  req.on("close", () => {
    closed = true;
    recordSseDisconnected("support");
    clearInterval(heartbeat);
    unsubscribe();
  });
}
