import { FastifyPluginAsync } from "fastify";
import {
  SupportTicketPriority,
  SupportTicketSource,
  SupportTicketStatus,
} from "@prisma/client";
import { z } from "zod/v4";

import { fastifyAuth } from "../../../modules/identity-access/transport/fastify-auth";
import { buildSupportScopeWhere } from "../../identity-access";
import {
  addSupportTicketMessage,
  addSupportTicketNote,
  assignSupportTicket,
  createSupportAssignmentRule,
  createSupportQueue,
  createSupportTicket,
  deleteSupportAssignmentRule,
  deleteSupportQueue,
  getSupportTicketScoped,
  listSupportAssignmentRules,
  listSupportAssignees,
  listSupportQueues,
  listSupportTickets,
  updateSupportAssignmentRule,
  updateSupportQueue,
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
import { applySseHeaders } from "../../../shared/http/sseHeaders";

function isWritableStream(stream: NodeJS.WritableStream & { destroyed?: boolean }) {
  return !stream.destroyed && (stream as any).writable !== false;
}

type EnumLike = Record<string, string>;

function actorFromRequest(request: any) {
  return {
    id: request.user?.id || "",
    companyId: request.user?.companyId || null,
    roleCodes: Array.isArray(request.user?.roleCodes) ? request.user.roleCodes : [],
    permissionCodes: Array.isArray(request.user?.permissionCodes) ? request.user.permissionCodes : [],
    name: request.user?.name,
    email: request.user?.email,
  };
}

function optionalEnumValue<T extends EnumLike>(enumObj: T, value: unknown) {
  const raw = String(value || "").trim();
  return Object.values(enumObj).includes(raw) ? (raw as T[keyof T]) : null;
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

function companyIdFromRequest(request: any) {
  return asOptionalString((request.query as any)?.companyId)
    || asOptionalString((request.body as any)?.companyId)
    || request.user?.companyId
    || "";
}

function sendError(reply: any, err: any, fallbackMessage: string) {
  return reply
    .code(err?.statusCode ?? 500)
    .send({ error: err?.message ?? fallbackMessage });
}

const idParamsSchema = z.object({
  id: z.string().trim().min(1),
});

const optionalNullableStringSchema = z.union([z.string().trim(), z.null()]).optional();

const supportQueueCreateBodySchema = z.object({
  companyId: z.string().trim().min(1).optional(),
  code: optionalNullableStringSchema,
  name: z.string().trim().min(1),
  description: optionalNullableStringSchema,
  defaultOrgId: optionalNullableStringSchema,
  defaultOwnerId: optionalNullableStringSchema,
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

const supportQueuePatchBodySchema = supportQueueCreateBodySchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one queue field is required",
);

const supportAssignmentRuleCreateBodySchema = z.object({
  companyId: z.string().trim().min(1).optional(),
  queueId: optionalNullableStringSchema,
  name: z.string().trim().min(1),
  code: optionalNullableStringSchema,
  source: z.string().trim().optional().nullable(),
  priority: z.string().trim().optional().nullable(),
  routeContains: optionalNullableStringSchema,
  defaultOwnerId: optionalNullableStringSchema,
  conditionsJson: z.record(z.string(), z.unknown()).nullable().optional(),
  sortOrder: z.coerce.number().int().optional(),
  isActive: z.boolean().optional(),
});

const supportAssignmentRulePatchBodySchema = supportAssignmentRuleCreateBodySchema
  .partial()
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one assignment rule field is required",
  );

const supportFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/stream",
    { preHandler: fastifyAuth({ permission: "support.view" }) },
    async (request, reply) => {
      applySseHeaders(request, reply);
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
    "/queues",
    { preHandler: fastifyAuth({ permission: "support.configure" }) },
    async (request, reply) => {
      try {
        const items = await listSupportQueues(companyIdFromRequest(request));
        return reply.send({ items });
      } catch (err: any) {
        return sendError(reply, err, "Failed to load support queues");
      }
    },
  );

  fastify.post(
    "/queues",
    {
      preHandler: fastifyAuth({ permission: "support.configure" }),
      schema: { body: supportQueueCreateBodySchema },
    },
    async (request, reply) => {
      try {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const queue = await createSupportQueue({
          companyId: companyIdFromRequest(request),
          code: asNullableString(body.code) ?? null,
          name: String(body.name || "").trim(),
          description: asNullableString(body.description) ?? null,
          defaultOrgId: asNullableString(body.defaultOrgId) ?? null,
          defaultOwnerId: asNullableString(body.defaultOwnerId) ?? null,
          isDefault: Boolean(body.isDefault),
          isActive: body.isActive !== false,
        });
        return reply.code(201).send(queue);
      } catch (err: any) {
        return sendError(reply, err, "Failed to create support queue");
      }
    },
  );

  fastify.patch(
    "/queues/:id",
    {
      preHandler: fastifyAuth({ permission: "support.configure" }),
      schema: { params: idParamsSchema, body: supportQueuePatchBodySchema },
    },
    async (request, reply) => {
      try {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const queue = await updateSupportQueue(String((request.params as any)?.id || ""), {
          code: body.code === undefined ? undefined : asNullableString(body.code) ?? null,
          name: body.name === undefined ? undefined : String(body.name || "").trim(),
          description:
            body.description === undefined ? undefined : asNullableString(body.description) ?? null,
          defaultOrgId:
            body.defaultOrgId === undefined ? undefined : asNullableString(body.defaultOrgId) ?? null,
          defaultOwnerId:
            body.defaultOwnerId === undefined ? undefined : asNullableString(body.defaultOwnerId) ?? null,
          isDefault: body.isDefault === undefined ? undefined : Boolean(body.isDefault),
          isActive: body.isActive === undefined ? undefined : Boolean(body.isActive),
        });
        return reply.send(queue);
      } catch (err: any) {
        return sendError(reply, err, "Failed to update support queue");
      }
    },
  );

  fastify.delete(
    "/queues/:id",
    {
      preHandler: fastifyAuth({ permission: "support.configure" }),
      schema: { params: idParamsSchema },
    },
    async (request, reply) => {
      try {
        const result = await deleteSupportQueue(String((request.params as any)?.id || ""));
        return reply.send(result);
      } catch (err: any) {
        return sendError(reply, err, "Failed to delete support queue");
      }
    },
  );

  fastify.get(
    "/assignment-rules",
    { preHandler: fastifyAuth({ permission: "support.configure" }) },
    async (request, reply) => {
      try {
        const items = await listSupportAssignmentRules(companyIdFromRequest(request));
        return reply.send({ items });
      } catch (err: any) {
        return sendError(reply, err, "Failed to load support assignment rules");
      }
    },
  );

  fastify.post(
    "/assignment-rules",
    {
      preHandler: fastifyAuth({ permission: "support.configure" }),
      schema: { body: supportAssignmentRuleCreateBodySchema },
    },
    async (request, reply) => {
      try {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const rule = await createSupportAssignmentRule({
          companyId: companyIdFromRequest(request),
          queueId: asNullableString(body.queueId) ?? null,
          name: String(body.name || "").trim(),
          code: asNullableString(body.code) ?? null,
          source: optionalEnumValue(SupportTicketSource, body.source),
          priority: optionalEnumValue(SupportTicketPriority, body.priority),
          routeContains: asNullableString(body.routeContains) ?? null,
          defaultOwnerId: asNullableString(body.defaultOwnerId) ?? null,
          conditionsJson: typeof body.conditionsJson === "object" && body.conditionsJson !== null
            ? (body.conditionsJson as any)
            : null,
          sortOrder: Number((body as any).sortOrder),
          isActive: body.isActive !== false,
        });
        return reply.code(201).send(rule);
      } catch (err: any) {
        return sendError(reply, err, "Failed to create support assignment rule");
      }
    },
  );

  fastify.patch(
    "/assignment-rules/:id",
    {
      preHandler: fastifyAuth({ permission: "support.configure" }),
      schema: {
        params: idParamsSchema,
        body: supportAssignmentRulePatchBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const rule = await updateSupportAssignmentRule(String((request.params as any)?.id || ""), {
          queueId: body.queueId === undefined ? undefined : asNullableString(body.queueId) ?? null,
          name: body.name === undefined ? undefined : String(body.name || "").trim(),
          code: body.code === undefined ? undefined : asNullableString(body.code) ?? null,
          source: body.source === undefined ? undefined : optionalEnumValue(SupportTicketSource, body.source),
          priority:
            body.priority === undefined ? undefined : optionalEnumValue(SupportTicketPriority, body.priority),
          routeContains:
            body.routeContains === undefined ? undefined : asNullableString(body.routeContains) ?? null,
          defaultOwnerId:
            body.defaultOwnerId === undefined ? undefined : asNullableString(body.defaultOwnerId) ?? null,
          conditionsJson:
            body.conditionsJson === undefined
              ? undefined
              : typeof body.conditionsJson === "object" && body.conditionsJson !== null
                ? (body.conditionsJson as any)
                : null,
          sortOrder: body.sortOrder === undefined ? undefined : Number((body as any).sortOrder),
          isActive: body.isActive === undefined ? undefined : Boolean(body.isActive),
        });
        return reply.send(rule);
      } catch (err: any) {
        return sendError(reply, err, "Failed to update support assignment rule");
      }
    },
  );

  fastify.delete(
    "/assignment-rules/:id",
    {
      preHandler: fastifyAuth({ permission: "support.configure" }),
      schema: { params: idParamsSchema },
    },
    async (request, reply) => {
      try {
        const result = await deleteSupportAssignmentRule(String((request.params as any)?.id || ""));
        return reply.send(result);
      } catch (err: any) {
        return sendError(reply, err, "Failed to delete support assignment rule");
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
            companyId: asNullableString(body.companyId) ?? request.user?.companyId ?? null,
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


