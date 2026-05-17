import { FastifyPluginAsync } from "fastify";
import { z, ZodError } from "zod";

import prisma from "../../../config/prismaClient";
import { fastifyAuth } from "../../../middleware/authFastify";
import { buildCustomerEntityScopeWhere } from "../../identity-access";
import { listAddresses } from "../application/addressRepo";

const addressCreateSchema = z.object({
  customerEntityId: z.string().uuid().optional().nullable(),
  country: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  neighborhood: z.string().optional().nullable(),
  street: z.string().optional().nullable(),
  latitude: z.number().optional().nullable(),
  longitude: z.number().optional().nullable(),
  addressLine1: z.string().optional().nullable(),
  addressLine2: z.string().optional().nullable(),
  building: z.string().optional().nullable(),
  apartment: z.string().optional().nullable(),
  floor: z.string().optional().nullable(),
  landmark: z.string().optional().nullable(),
  postalCode: z.string().optional().nullable(),
  addressType: z.enum(["RESIDENTIAL", "BUSINESS"]).optional().nullable(),
  isSaved: z.boolean().optional().default(true),
});

function sendError(reply: any, err: any, fallback: string) {
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: "Validation failed", issues: err.flatten() });
  }
  return reply.code(err?.statusCode ?? 500).send({ error: err?.message ?? fallback });
}

const addressesFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/",
    { preHandler: fastifyAuth({ permission: "customers.read" }) },
    async (request, reply) => {
      try {
        const q = typeof (request.query as any)?.q === "string" ? (request.query as any).q : undefined;
        const take = (request.query as any)?.take ? Number((request.query as any).take) : undefined;
        const queryCustomerEntityId =
          typeof (request.query as any)?.customerEntityId === "string"
            ? (request.query as any).customerEntityId
            : undefined;

        const scopeWhere = await buildCustomerEntityScopeWhere(request.user!);
        if (scopeWhere?.id === "__no_access__") {
          return reply.code(403).send({ error: "Forbidden" });
        }

        let customerEntityId: string | undefined;
        if (!scopeWhere || Object.keys(scopeWhere).length === 0) {
          customerEntityId = queryCustomerEntityId;
        } else if (scopeWhere.id && typeof scopeWhere.id === "string") {
          customerEntityId = scopeWhere.id;
          if (queryCustomerEntityId && queryCustomerEntityId !== customerEntityId) {
            return reply.code(403).send({ error: "Forbidden" });
          }
        } else {
          customerEntityId = request.user?.customerEntityId ?? undefined;
          if (queryCustomerEntityId && queryCustomerEntityId !== customerEntityId) {
            return reply.code(403).send({ error: "Forbidden" });
          }
        }

        const rows = await listAddresses({ customerEntityId, q, take });
        return reply.send(rows);
      } catch (err: any) {
        return sendError(reply, err, "Failed to fetch addresses");
      }
    },
  );

  fastify.post(
    "/",
    { preHandler: fastifyAuth({ permission: "customers.write" }) },
    async (request, reply) => {
      try {
        const dto = addressCreateSchema.parse(request.body);
        const scopeWhere = await buildCustomerEntityScopeWhere(request.user!);
        if (scopeWhere?.id === "__no_access__") {
          return reply.code(403).send({ error: "Forbidden" });
        }

        let ownerCustomerEntityId: string | null = null;
        if (!scopeWhere || Object.keys(scopeWhere).length === 0) {
          ownerCustomerEntityId = dto.customerEntityId ?? request.user?.customerEntityId ?? null;
        } else if (scopeWhere.id && typeof scopeWhere.id === "string") {
          ownerCustomerEntityId = scopeWhere.id;
          if (dto.customerEntityId && dto.customerEntityId !== ownerCustomerEntityId) {
            return reply.code(403).send({ error: "Forbidden" });
          }
        } else {
          ownerCustomerEntityId = request.user?.customerEntityId ?? null;
          if (dto.customerEntityId && dto.customerEntityId !== ownerCustomerEntityId) {
            return reply.code(403).send({ error: "Forbidden" });
          }
        }

        if (!ownerCustomerEntityId) {
          return reply.code(400).send({
            error: "customerEntityId is required to create an address",
          });
        }

        const created = await prisma.address.create({
          data: {
            customerEntity: {
              connect: { id: ownerCustomerEntityId },
            },
            country: dto.country ?? null,
            city: dto.city ?? null,
            neighborhood: dto.neighborhood ?? null,
            street: dto.street ?? null,
            latitude: dto.latitude ?? null,
            longitude: dto.longitude ?? null,
            addressLine1: dto.addressLine1 ?? null,
            addressLine2: dto.addressLine2 ?? null,
            building: dto.building ?? null,
            apartment: dto.apartment ?? null,
            floor: dto.floor ?? null,
            landmark: dto.landmark ?? null,
            postalCode: dto.postalCode ?? null,
            addressType: (dto.addressType as any) ?? null,
            isSaved: dto.isSaved ?? true,
          },
        });

        return reply.code(201).send(created);
      } catch (err: any) {
        return sendError(reply, err, "Failed to create address");
      }
    },
  );
};

export default addressesFastifyRoutes;

