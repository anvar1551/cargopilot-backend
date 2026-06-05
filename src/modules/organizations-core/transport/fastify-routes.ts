import { OrganizationType, Prisma } from "@prisma/client";
import { FastifyPluginAsync } from "fastify";
import { z, ZodError } from "zod";
import {
  buildOrganizationScopeWhere,
  hasAnyPermissionSync,
} from "../../identity-access";
import { fastifyAuth } from "../../identity-access/transport/fastify-auth";
import {
  createOrganization,
  deactivateOrganization,
  getOrganizationById,
  isAllowedParentType,
  listOrganizations,
  updateOrganization,
} from "../application/organizationRepo";

const organizationTypeSchema = z.enum([
  "company",
  "branch",
  "agent",
  "pickup_point",
  "carrier",
  "client",
]);

const listOrganizationsQuerySchema = z.object({
  type: organizationTypeSchema.optional(),
  parentOrgId: z.string().uuid().optional(),
  isActive: z
    .string()
    .optional()
    .transform((value) => {
      if (value == null || value === "") return undefined;
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "1") return true;
      if (normalized === "false" || normalized === "0") return false;
      return undefined;
    }),
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  type: organizationTypeSchema,
  code: z.string().trim().min(2).max(64).optional().nullable(),
  parentOrgId: z.string().uuid().optional().nullable(),
  isActive: z.boolean().optional(),
});

const updateOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  type: organizationTypeSchema.optional(),
  code: z.string().trim().min(2).max(64).optional().nullable(),
  parentOrgId: z.string().uuid().optional().nullable(),
  isActive: z.boolean().optional(),
});

function sendError(reply: any, err: unknown, fallback: string) {
  if (err instanceof ZodError) {
    return reply
      .code(400)
      .send({ error: "Validation failed", issues: err.flatten() });
  }
  const anyErr = err as { statusCode?: number; message?: string };
  return reply
    .code(anyErr?.statusCode ?? 500)
    .send({ error: anyErr?.message ?? fallback });
}

function asOrganizationType(value: string) {
  return value as OrganizationType;
}

async function resolveParentForWrite(args: {
  parentOrgId: string | null;
  scopeWhere: Prisma.OrganizationWhereInput | null;
}) {
  if (!args.parentOrgId) return null;
  const parent = await getOrganizationById({
    id: args.parentOrgId,
    where: args.scopeWhere,
  });
  if (!parent) {
    const err = new Error("Parent organization is not accessible") as Error & {
      statusCode: number;
    };
    err.statusCode = 403;
    throw err;
  }
  return parent;
}

function enforceHierarchy(args: {
  childType: OrganizationType;
  parentType: OrganizationType | null;
}) {
  if (!isAllowedParentType(args)) {
    const err = new Error(
      `Invalid hierarchy: ${args.childType} cannot be nested under ${args.parentType ?? "null"}`,
    ) as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
}

const organizationsFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/",
    { preHandler: fastifyAuth({ permission: "organizations.read" }) },
    async (request, reply) => {
      try {
        const query = listOrganizationsQuerySchema.parse(request.query ?? {});
        const scopeWhere = await buildOrganizationScopeWhere(request.user!);
        const result = await listOrganizations({
          where: scopeWhere ?? undefined,
          type: query.type ? asOrganizationType(query.type) : undefined,
          parentOrgId: query.parentOrgId ?? undefined,
          isActive: query.isActive,
          q: query.q,
          page: query.page,
          limit: query.limit,
        });
        return reply.send(result);
      } catch (err) {
        return sendError(reply, err, "Failed to list organizations");
      }
    },
  );

  fastify.get(
    "/:id",
    { preHandler: fastifyAuth({ permission: "organizations.read" }) },
    async (request, reply) => {
      try {
        const id = String((request.params as any)?.id || "").trim();
        if (!id) return reply.code(400).send({ error: "Organization id is required" });
        const scopeWhere = await buildOrganizationScopeWhere(request.user!);
        const item = await getOrganizationById({ id, where: scopeWhere });
        if (!item) return reply.code(404).send({ error: "Organization not found" });
        return reply.send(item);
      } catch (err) {
        return sendError(reply, err, "Failed to fetch organization");
      }
    },
  );

  fastify.post(
    "/",
    { preHandler: fastifyAuth({ permission: "organizations.write" }) },
    async (request, reply) => {
      try {
        const body = createOrganizationSchema.parse(request.body ?? {});
        const scopeWhere = await buildOrganizationScopeWhere(request.user!);
        const parent = await resolveParentForWrite({
          parentOrgId: body.parentOrgId ?? null,
          scopeWhere,
        });
        enforceHierarchy({
          childType: asOrganizationType(body.type),
          parentType: (parent?.type as OrganizationType | undefined) ?? null,
        });

        if (
          body.type === "company" &&
          !parent &&
          !hasAnyPermissionSync(request.user!, ["policy.override"])
        ) {
          return reply
            .code(403)
            .send({ error: "Creating top-level company requires policy.override" });
        }

        const created = await createOrganization({
          name: body.name,
          type: asOrganizationType(body.type),
          code: body.code ?? null,
          parentOrgId: body.parentOrgId ?? null,
          isActive: body.isActive ?? true,
        });
        return reply.code(201).send(created);
      } catch (err: any) {
        if (err?.code === "P2002") {
          return reply.code(409).send({ error: "Organization code already exists" });
        }
        return sendError(reply, err, "Failed to create organization");
      }
    },
  );

  fastify.put(
    "/:id",
    { preHandler: fastifyAuth({ permission: "organizations.write" }) },
    async (request, reply) => {
      try {
        const id = String((request.params as any)?.id || "").trim();
        if (!id) return reply.code(400).send({ error: "Organization id is required" });
        const body = updateOrganizationSchema.parse(request.body ?? {});
        const scopeWhere = await buildOrganizationScopeWhere(request.user!);
        const current = await getOrganizationById({ id, where: scopeWhere });
        if (!current) return reply.code(404).send({ error: "Organization not found" });

        const nextType = body.type
          ? asOrganizationType(body.type)
          : (current.type as OrganizationType);
        const nextParentId =
          body.parentOrgId === undefined ? current.parentOrgId : body.parentOrgId;
        if (nextParentId === id) {
          return reply.code(400).send({ error: "Organization cannot be its own parent" });
        }
        const parent = await resolveParentForWrite({
          parentOrgId: nextParentId ?? null,
          scopeWhere,
        });
        enforceHierarchy({
          childType: nextType,
          parentType: (parent?.type as OrganizationType | undefined) ?? null,
        });

        if (
          nextType === "company" &&
          !parent &&
          !hasAnyPermissionSync(request.user!, ["policy.override"])
        ) {
          return reply
            .code(403)
            .send({ error: "Creating top-level company requires policy.override" });
        }

        const updated = await updateOrganization({
          id,
          name: body.name,
          type: nextType,
          code: body.code,
          parentOrgId: nextParentId ?? null,
          isActive: body.isActive,
        });
        return reply.send(updated);
      } catch (err: any) {
        if (err?.code === "P2002") {
          return reply.code(409).send({ error: "Organization code already exists" });
        }
        return sendError(reply, err, "Failed to update organization");
      }
    },
  );

  fastify.delete(
    "/:id",
    { preHandler: fastifyAuth({ permission: "organizations.write" }) },
    async (request, reply) => {
      try {
        const id = String((request.params as any)?.id || "").trim();
        if (!id) return reply.code(400).send({ error: "Organization id is required" });
        const scopeWhere = await buildOrganizationScopeWhere(request.user!);
        const current = await getOrganizationById({ id, where: scopeWhere });
        if (!current) return reply.code(404).send({ error: "Organization not found" });

        const deactivated = await deactivateOrganization(id);
        return reply.send(deactivated);
      } catch (err) {
        return sendError(reply, err, "Failed to delete organization");
      }
    },
  );
};

export default organizationsFastifyRoutes;

