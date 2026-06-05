import { FastifyPluginAsync } from "fastify";
import {
  SupportTicketPriority,
  SupportTicketSource,
  SupportTicketStatus,
} from "@prisma/client";

import { fastifyAuth } from "../../../modules/identity-access/transport/fastify-auth";
import { buildSupportScopeWhere } from "../../identity-access";
import {
  addSupportTicketMessage,
  addSupportTicketNote,
  assignSupportTicket,
  createSupportTicket,
  getSupportTicketScoped,
  listSupportAssignees,
  listSupportTickets,
  updateSupportTicketStatus,
} from "../application/supportService";
import {
  replaySupportRefreshFromRedis,
  replaySupportRefreshSince,
  subscribeSupportRefresh,
} from "../realtime/supportRealtime";
import {
  recordSseConnected,
  recordSseDisconnected,
} from "../../../modules/observability-core/application/opsMetrics";

function isWritableStream(stream: NodeJS.WritableStream & { destroyed?: boolean }) {
  return !stream.destroyed && (stream as any).writable !== false;
}

type EnumLike = Record<string, string>;

function actorFromRequest(request: any) {
  return {
    id: request.user?.id || "",
    roleCodes: Array.isArray(request.user?.roleCodes) ? request.user.roleCodes : [],
    permissionCodes: Array.isArray(request.user?.permissionCodes) ? request.user.permissionCodes : [],
    name: request.user?.name,
    email: request.user?.email,
  };
}

function asEnumValue<T extends EnumLike>(
  enumObj: T,
  value: unknown,
  fallback: T[keyof T],
) {
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

function sendError(reply: any, err: any, fallbackMessage: string) {
  return reply
    .code(err?.statusCode ?? 500)
    .send({ error: err?.message ?? fallbackMessage });
}

const supportFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/stream",
    { preHandler: fastifyAuth({ permission: "support.view" }) },
    async (request, reply) => {
      reply.header("Content-Type", "text/event-stream");
      reply.header("Cache-Control", "no-cache, no-transform");
      reply.header("Connection", "keep-alive");
      reply.header("X-Accel-Buffering", "no");
      reply.raw.flushHeaders?.();

      const clientKey = `${request.user?.id || "anon"}:${request.ip || "ip"}`;
      const lastEventId = String(
        request.headers["last-event-id"] || request.headers["Last-Event-ID"] || "",
      ).trim();
      let disconnected = false;

      recordSseConnected({ stream: "support", clientKey });
      let closed = false;

      const send = (event: string, payload: unknown, id?: string | null) => {
        if (closed || !isWritableStream(reply.raw)) return false;
        try {
          if (id) reply.raw.write(`id: ${id}\n`);
          reply.raw.write(`event: ${event}\n`);
          reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
          return true;
        } catch {
          return false;
        }
      };

      if (!send("ready", {
        connectedAt: new Date().toISOString(),
        resumedFrom: lastEventId || null,
      })) {
        if (!disconnected) {
          disconnected = true;
          recordSseDisconnected("support");
        }
        return reply.hijack();
      }

      const redisReplayEvents = await replaySupportRefreshFromRedis({
        lastEventId,
        limit: Number(process.env.SUPPORT_STREAM_REPLAY_MAX_EVENTS || 200),
      });
      const replayEvents = redisReplayEvents.length
        ? redisReplayEvents
        : replaySupportRefreshSince(lastEventId);
      const replayLimit = Math.max(
        10,
        Number(process.env.SUPPORT_STREAM_REPLAY_MAX_EVENTS || 200),
      );
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
        if (closed || !isWritableStream(reply.raw)) return;
        try {
          reply.raw.write(`: ping ${Date.now()}\n\n`);
        } catch {
          closed = true;
        }
      }, Math.max(10_000, Number(process.env.SUPPORT_STREAM_HEARTBEAT_MS || 25_000)));

      const unsubscribe = subscribeSupportRefresh((event) => {
        const sent = send("support-refresh", event, event.id);
        if (!sent) closed = true;
      });

      const onClose = () => {
        if (disconnected) return;
        disconnected = true;
        closed = true;
        recordSseDisconnected("support");
        clearInterval(heartbeat);
        unsubscribe();
      };

      request.raw.on("close", onClose);
      reply.raw.on("close", onClose);
      reply.raw.on("error", onClose);

      return reply.hijack();
    },
  );

  fastify.get(
    "/assignees",
    { preHandler: fastifyAuth({ permission: "support.view" }) },
    async (_request, reply) => {
      try {
        const assignees = await listSupportAssignees();
        return reply.send({ items: assignees });
      } catch (err: any) {
        return sendError(reply, err, "Failed to load support assignees");
      }
    },
  );

  fastify.get(
    "/tickets",
    { preHandler: fastifyAuth({ permission: "support.view" }) },
    async (request, reply) => {
      const startedAt = Date.now();
      try {
        const scopeWhere = await buildSupportScopeWhere(request.user!);
        const limit = Number((request.query as any)?.limit);

        const result = await listSupportTickets({
          status: asOptionalString((request.query as any)?.status),
          priority: asOptionalString((request.query as any)?.priority),
          source: asOptionalString((request.query as any)?.source),
          owner: ((asOptionalString((request.query as any)?.owner) as any) || "mine") as
            | "mine"
            | "unassigned"
            | "all",
          q: asOptionalString((request.query as any)?.q),
          cursor: asOptionalString((request.query as any)?.cursor),
          limit: Number.isFinite(limit) ? limit : undefined,
          includeArchived:
            String((request.query as any)?.includeArchived || "") === "true",
          actor: actorFromRequest(request),
          scopeWhere,
        });

        reply.header("X-Support-Cache", result.cacheHit ? "HIT" : "MISS");
        reply.header("X-Support-Time-Ms", String(Date.now() - startedAt));
        return reply.send(result.payload);
      } catch (err: any) {
        return sendError(reply, err, "Failed to load support tickets");
      }
    },
  );

  fastify.post(
    "/tickets",
    { preHandler: fastifyAuth({ permission: "support.createTicket" }) },
    async (request, reply) => {
      try {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const ticket = await createSupportTicket(
          {
            orderId: asNullableString(body.orderId) ?? null,
            orderNumber: asNullableString(body.orderNumber) ?? null,
            title: String(body.title || "").trim(),
            summary: asNullableString(body.summary) ?? null,
            priority: asEnumValue(
              SupportTicketPriority,
              body.priority,
              SupportTicketPriority.normal,
            ),
            source: asEnumValue(
              SupportTicketSource,
              body.source,
              SupportTicketSource.manager,
            ),
            status: asEnumValue(
              SupportTicketStatus,
              body.status,
              SupportTicketStatus.open,
            ),
            ownerId:
              body.ownerId === null ? null : asOptionalString(body.ownerId),
            sourceKey: asNullableString(body.sourceKey) ?? null,
          },
          actorFromRequest(request),
        );
        return reply.code(201).send(ticket);
      } catch (err: any) {
        const status = String(err?.message || "").includes("required")
          ? 400
          : err?.statusCode ?? 500;
        return reply
          .code(status)
          .send({ error: err?.message || "Failed to create support ticket" });
      }
    },
  );

  fastify.get(
    "/tickets/:id",
    { preHandler: fastifyAuth({ permission: "support.view" }) },
    async (request, reply) => {
      const startedAt = Date.now();
      try {
        const scopeWhere = await buildSupportScopeWhere(request.user!);
        const id = String((request.params as any)?.id || "").trim();
        const result = await getSupportTicketScoped({ id, scopeWhere });

        reply.header("X-Support-Cache", result.cacheHit ? "HIT" : "MISS");
        reply.header("X-Support-Time-Ms", String(Date.now() - startedAt));

        if (!result.payload) {
          return reply.code(404).send({ error: "Support ticket not found" });
        }
        return reply.send(result.payload);
      } catch (err: any) {
        return sendError(reply, err, "Failed to load support ticket");
      }
    },
  );

  fastify.patch(
    "/tickets/:id/status",
    { preHandler: fastifyAuth({ permission: "support.update" }) },
    async (request, reply) => {
      try {
        const status = asEnumValue(
          SupportTicketStatus,
          (request.body as any)?.status,
          SupportTicketStatus.open,
        );
        const ticket = await updateSupportTicketStatus(
          String((request.params as any)?.id || ""),
          status,
          actorFromRequest(request),
        );
        return reply.send(ticket);
      } catch (err: any) {
        return sendError(reply, err, "Failed to update support ticket status");
      }
    },
  );

  fastify.patch(
    "/tickets/:id/assign", { preHandler: fastifyAuth({ permission: "support.assign" }) },
    async (request, reply) => {
      try {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const ownerId =
          body.ownerId === null
            ? null
            : asOptionalString(body.ownerId) || request.user?.id || null;
        const ticket = await assignSupportTicket(
          String((request.params as any)?.id || ""),
          ownerId,
          actorFromRequest(request),
        );
        return reply.send(ticket);
      } catch (err: any) {
        return sendError(reply, err, "Failed to assign support ticket");
      }
    },
  );

  fastify.post(
    "/tickets/:id/notes",
    { preHandler: fastifyAuth({ permission: "support.update" }) },
    async (request, reply) => {
      try {
        const ticket = await addSupportTicketNote(
          String((request.params as any)?.id || ""),
          String((request.body as any)?.body || ""),
          actorFromRequest(request),
        );
        return reply.code(201).send(ticket);
      } catch (err: any) {
        const status = String(err?.message || "").includes("required")
          ? 400
          : err?.statusCode ?? 500;
        return reply
          .code(status)
          .send({ error: err?.message || "Failed to add support note" });
      }
    },
  );

  fastify.post(
    "/tickets/:id/messages",
    { preHandler: fastifyAuth({ permission: "support.update" }) },
    async (request, reply) => {
      try {
        const ticket = await addSupportTicketMessage(
          String((request.params as any)?.id || ""),
          String((request.body as any)?.body || ""),
          actorFromRequest(request),
        );
        return reply.code(201).send(ticket);
      } catch (err: any) {
        const status = String(err?.message || "").includes("required")
          ? 400
          : err?.statusCode ?? 500;
        return reply
          .code(status)
          .send({ error: err?.message || "Failed to add support message" });
      }
    },
  );

  fastify.post(
    "/tickets/:id/escalate", { preHandler: fastifyAuth({ permission: "support.escalate" }) },
    async (request, reply) => {
      try {
        const ticket = await updateSupportTicketStatus(
          String((request.params as any)?.id || ""),
          SupportTicketStatus.escalated,
          actorFromRequest(request),
        );
        return reply.send(ticket);
      } catch (err: any) {
        return sendError(reply, err, "Failed to escalate support ticket");
      }
    },
  );
};

export default supportFastifyRoutes;


