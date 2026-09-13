import { FastifyPluginAsync } from "fastify";
import { z, ZodError } from "zod";

import { fastifyAuth } from "../../../modules/identity-access/transport/fastify-auth";
import {
  createAddress,
  deleteAddress,
  getAddressById,
  listAddresses,
  updateAddress,
} from "../application/addressRepo";

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
}).strict();

const addressUpdateSchema = addressCreateSchema.omit({ customerEntityId: true }).partial().strict();

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

        const rows = await listAddresses(request.user!, { customerEntityId: queryCustomerEntityId, q, take });
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
        if (!dto.customerEntityId) return reply.code(400).send({ error: "customerEntityId is required" });
        const created = await createAddress(request.user!, { ...dto, customerEntityId: dto.customerEntityId });
        return reply.code(201).send(created);
      } catch (err: any) {
        return sendError(reply, err, "Failed to create address");
      }
    },
  );

  fastify.get(
    "/:id",
    { preHandler: fastifyAuth({ permission: "customers.read" }) },
    async (request, reply) => {
      try {
        const id = String((request.params as any)?.id ?? "").trim();
        if (!id) return reply.code(400).send({ error: "Address id is required" });
        const address = await getAddressById(request.user!, id);
        if (!address) return reply.code(404).send({ error: "Not found" });
        return reply.send(address);
      } catch (err: any) {
        return sendError(reply, err, "Failed to fetch address");
      }
    },
  );

  fastify.patch(
    "/:id",
    { preHandler: fastifyAuth({ permission: "customers.write" }) },
    async (request, reply) => {
      try {
        const id = String((request.params as any)?.id ?? "").trim();
        if (!id) return reply.code(400).send({ error: "Address id is required" });
        const dto = addressUpdateSchema.parse(request.body);
        const updated = await updateAddress(request.user!, id, dto);
        if (!updated) return reply.code(404).send({ error: "Not found" });
        return reply.send(updated);
      } catch (err: any) {
        return sendError(reply, err, "Failed to update address");
      }
    },
  );

  fastify.delete(
    "/:id",
    { preHandler: fastifyAuth({ permission: "customers.write" }) },
    async (request, reply) => {
      try {
        const id = String((request.params as any)?.id ?? "").trim();
        if (!id) return reply.code(400).send({ error: "Address id is required" });
        const deleted = await deleteAddress(request.user!, id);
        if (!deleted) return reply.code(404).send({ error: "Not found" });
        return reply.code(204).send();
      } catch (err: any) {
        return sendError(reply, err, "Failed to delete address");
      }
    },
  );
};

export default addressesFastifyRoutes;

