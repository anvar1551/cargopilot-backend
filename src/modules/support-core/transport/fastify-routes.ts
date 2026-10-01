import { rejectSupportOwnership, supportError } from "../application/supportAccess";
import { FastifyPluginAsync } from "fastify";
import {
  SupportTicketPriority,
  SupportTicketSource,
  SupportTicketStatus,
} from "@prisma/client";
import { z } from "zod/v4";

import { fastifyAuth } from "../../../modules/identity-access/transport/fastify-auth";
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
  getSupportSummary,
  listSupportAssignmentRules,
  listSupportAssignees,
  listSupportQueues,
  listSupportTickets,
  updateSupportAssignmentRule,
  updateSupportQueue,
  updateSupportTicketStatus,
} from "../application/supportService";
type EnumLike = Record<string, string>;

function actorFromRequest(request: any) { return request.user; }

function optionalEnumValue<T extends EnumLike>(enumObj: T, value: unknown) {
  const raw = String(value || "").trim();
  return Object.values(enumObj).includes(raw) ? (raw as T[keyof T]) : null;
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
  if (Object.prototype.hasOwnProperty.call(request.body ?? {}, "companyId") || Object.prototype.hasOwnProperty.call(request.query ?? {}, "companyId")) throw supportError("Company selection is server controlled", 400);
  return request.user?.companyId ?? "";
}

function hasRequestPermission(request: any, permission: string) {
  return Array.isArray(request.user?.permissionCodes)
    && request.user.permissionCodes.includes(permission);
}

function sendError(reply: any, err: any, fallbackMessage: string) {
  return reply
    .code(err?.statusCode ?? 500)
    .send({ error: [400,403,404,409].includes(err?.statusCode) ? err.message : fallbackMessage });
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
  fastify.addHook("preValidation", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const route = String(request.routeOptions.url);
      if (route.includes("/tickets")) {
        rejectSupportOwnership(body);
        const allowed = route.endsWith("/messages") || route.endsWith("/notes") ? ["body"] : route.endsWith("/status") ? ["status"] : route.endsWith("/assign") ? ["ownerId"] : route.endsWith("/escalate") ? [] : ["orderId","orderNumber","title","summary","priority","ownerId"];
        if (Object.keys(body).some(k => !allowed.includes(k))) throw supportError("Unsupported support field", 400);
      }
      else if (["tenantId", "companyId", "ownerOrgId", "assignedOrgId", "ownerCompanyMembershipId"].some(k => Object.prototype.hasOwnProperty.call(body, k))) throw supportError("Ownership is server controlled", 400);
    } catch(error: any) { return reply.code(error.statusCode).send({ error: error.message }); }
  });
  fastify.get("/stream", { preHandler: fastifyAuth({ permission: "support.view" }) }, async (_request, reply) => reply.code(503).send({ error: "Support live refresh is unavailable until tenant-scoped delivery is implemented" }));

  fastify.get(
    "/assignees",
    { preHandler: fastifyAuth({ permission: "support.view" }) },
    async (request, reply) => {
      try {
        const assignees = await listSupportAssignees(actorFromRequest(request));
        return reply.send({ items: assignees });
      } catch (err: any) {
        return sendError(reply, err, "Failed to load support assignees");
      }
    },
  );

  fastify.get(
    "/summary",
    { preHandler: fastifyAuth({ permission: "support.view" }) },
    async (request, reply) => {
      try {
        const summary = await getSupportSummary({
          includeArchived: (request.query as any)?.includeArchived === "true",
          actor: actorFromRequest(request),
        });
        return reply.send(summary);
      } catch (err: any) {
        return sendError(reply, err, "Failed to load support summary");
      }
    },
  );

  fastify.get(
    "/queues",
    { preHandler: fastifyAuth({ permission: "support.configure" }) },
    async (request, reply) => {
      try {
        const items = await listSupportQueues(companyIdFromRequest(request), actorFromRequest(request));
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
        const defaultOwnerId = asNullableString(body.defaultOwnerId) ?? null;
        const queue = await createSupportQueue({
          companyId: companyIdFromRequest(request),
          code: asNullableString(body.code) ?? null,
          name: String(body.name || "").trim(),
          description: asNullableString(body.description) ?? null,
          defaultOrgId: asNullableString(body.defaultOrgId) ?? null,
          defaultOwnerId,
          isDefault: Boolean(body.isDefault),
          isActive: body.isActive !== false,
        }, actorFromRequest(request));
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
        const queueId = String((request.params as any)?.id || "");
        const body = (request.body ?? {}) as Record<string, unknown>;
        const defaultOwnerId = body.defaultOwnerId === undefined
          ? undefined
          : asNullableString(body.defaultOwnerId) ?? null;
        const queue = await updateSupportQueue(queueId, {
          code: body.code === undefined ? undefined : asNullableString(body.code) ?? null,
          name: body.name === undefined ? undefined : String(body.name || "").trim(),
          description:
            body.description === undefined ? undefined : asNullableString(body.description) ?? null,
          defaultOrgId:
            body.defaultOrgId === undefined ? undefined : asNullableString(body.defaultOrgId) ?? null,
          defaultOwnerId,
          isDefault: body.isDefault === undefined ? undefined : Boolean(body.isDefault),
          isActive: body.isActive === undefined ? undefined : Boolean(body.isActive),
        }, actorFromRequest(request));
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
        const queueId = String((request.params as any)?.id || "");
        const result = await deleteSupportQueue(queueId, actorFromRequest(request));
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
        const items = await listSupportAssignmentRules(companyIdFromRequest(request), actorFromRequest(request));
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
        const queueId = asNullableString(body.queueId) ?? null;
        const defaultOwnerId = asNullableString(body.defaultOwnerId) ?? null;
        const rule = await createSupportAssignmentRule({
          companyId: companyIdFromRequest(request),
          queueId,
          name: String(body.name || "").trim(),
          code: asNullableString(body.code) ?? null,
          source: optionalEnumValue(SupportTicketSource, body.source),
          priority: optionalEnumValue(SupportTicketPriority, body.priority),
          routeContains: asNullableString(body.routeContains) ?? null,
          defaultOwnerId,
          conditionsJson: typeof body.conditionsJson === "object" && body.conditionsJson !== null
            ? (body.conditionsJson as any)
            : null,
          sortOrder: Number((body as any).sortOrder),
          isActive: body.isActive !== false,
        }, actorFromRequest(request));
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
        const ruleId = String((request.params as any)?.id || "");
        const body = (request.body ?? {}) as Record<string, unknown>;
        const queueId = body.queueId === undefined ? undefined : asNullableString(body.queueId) ?? null;
        const defaultOwnerId = body.defaultOwnerId === undefined
          ? undefined
          : asNullableString(body.defaultOwnerId) ?? null;
        const rule = await updateSupportAssignmentRule(ruleId, {
          queueId,
          name: body.name === undefined ? undefined : String(body.name || "").trim(),
          code: body.code === undefined ? undefined : asNullableString(body.code) ?? null,
          source: body.source === undefined ? undefined : optionalEnumValue(SupportTicketSource, body.source),
          priority:
            body.priority === undefined ? undefined : optionalEnumValue(SupportTicketPriority, body.priority),
          routeContains:
            body.routeContains === undefined ? undefined : asNullableString(body.routeContains) ?? null,
          defaultOwnerId,
          conditionsJson:
            body.conditionsJson === undefined
              ? undefined
              : typeof body.conditionsJson === "object" && body.conditionsJson !== null
                ? (body.conditionsJson as any)
                : null,
          sortOrder: body.sortOrder === undefined ? undefined : Number((body as any).sortOrder),
          isActive: body.isActive === undefined ? undefined : Boolean(body.isActive),
        }, actorFromRequest(request));
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
        const ruleId = String((request.params as any)?.id || "");
        const result = await deleteSupportAssignmentRule(ruleId, actorFromRequest(request));
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
        const orderId = asNullableString(body.orderId) ?? null;
        const orderNumber = asNullableString(body.orderNumber) ?? null;
        const ticket = await createSupportTicket(
          {
            orderId,
            orderNumber,
            title: String(body.title || "").trim(),
            summary: asNullableString(body.summary) ?? null,
            priority: body.priority === undefined ? SupportTicketPriority.normal : (() => {
              const value = optionalEnumValue(SupportTicketPriority, body.priority);
              if (!value) throw supportError("Invalid support priority", 400);
              return value;
            })(),
            ownerId: body.ownerId === undefined ? undefined : body.ownerId === null ? null : String(body.ownerId),
          },
          actorFromRequest(request),
        );
        return reply.code(201).send(ticket);
      } catch (err: any) {
        const status = err?.statusCode ?? 500;
        return reply
          .code(status)
          .send({ error: [400,403,404,409].includes(status) ? err.message : "Support operation failed" });
      }
    },
  );

  fastify.get(
    "/tickets/:id",
    { preHandler: fastifyAuth({ permission: "support.view" }) },
    async (request, reply) => {
      const startedAt = Date.now();
      try {
        const id = String((request.params as any)?.id || "").trim();
        const result = await getSupportTicketScoped({ id, actor: actorFromRequest(request) });

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
        const ticketId = String((request.params as any)?.id || "");
        const status = optionalEnumValue(SupportTicketStatus, (request.body as any)?.status);
        if (!status) throw supportError("Invalid support status", 400);
        if (status === SupportTicketStatus.resolved && !hasRequestPermission(request, "support.resolve")) {
          return reply.code(403).send({ error: "Missing permission: support.resolve" });
        }
        if (status === SupportTicketStatus.escalated && !hasRequestPermission(request, "support.escalate")) {
          return reply.code(403).send({ error: "Missing permission: support.escalate" });
        }
        const ticket = await updateSupportTicketStatus(
          ticketId,
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
        const ticketId = String((request.params as any)?.id || "");
        const body = (request.body ?? {}) as Record<string, unknown>;
        const ownerId =
          body.ownerId === null
            ? null
            : asOptionalString(body.ownerId) || request.user?.id || null;
        const ticket = await assignSupportTicket(
          ticketId,
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
        const ticketId = String((request.params as any)?.id || "");
        const ticket = await addSupportTicketNote(
          ticketId,
          String((request.body as any)?.body || ""),
          actorFromRequest(request),
        );
        return reply.code(201).send(ticket);
      } catch (err: any) {
        const status = err?.statusCode ?? 500;
        return reply
          .code(status)
          .send({ error: [400,403,404,409].includes(status) ? err.message : "Support operation failed" });
      }
    },
  );

  fastify.post(
    "/tickets/:id/messages",
    { preHandler: fastifyAuth({ permission: "support.update" }) },
    async (request, reply) => {
      try {
        const ticketId = String((request.params as any)?.id || "");
        const ticket = await addSupportTicketMessage(
          ticketId,
          String((request.body as any)?.body || ""),
          actorFromRequest(request),
        );
        return reply.code(201).send(ticket);
      } catch (err: any) {
        const status = err?.statusCode ?? 500;
        return reply
          .code(status)
          .send({ error: [400,403,404,409].includes(status) ? err.message : "Support operation failed" });
      }
    },
  );

  fastify.post(
    "/tickets/:id/escalate", { preHandler: fastifyAuth({ permission: "support.escalate" }) },
    async (request, reply) => {
      try {
        const ticketId = String((request.params as any)?.id || "");
        const ticket = await updateSupportTicketStatus(
          ticketId,
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


