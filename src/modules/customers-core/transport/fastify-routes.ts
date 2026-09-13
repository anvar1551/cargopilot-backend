import { CustomerType } from "@prisma/client";
import { FastifyPluginAsync } from "fastify";
import { ZodError, z } from "zod";
import { fastifyAuth } from "../../../modules/identity-access/transport/fastify-auth";
import {
  createCustomerEntity,
  deleteCustomerEntity,
  getCustomerEntityById,
  listCustomerEntities,
  updateCustomerEntity,
} from "../application/customerEntityRepo";

const createCustomerSchema = z
  .object({
    type: z.enum(["PERSON", "COMPANY"]),
    name: z.string().min(2),
    email: z.string().email().optional().nullable(),
    phone: z.string().optional().nullable(),
    altPhone1: z.string().optional().nullable(),
    altPhone2: z.string().optional().nullable(),
    companyName: z.string().optional().nullable(),
    taxId: z.string().optional().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.type === "COMPANY") {
      if (!value.companyName) {
        ctx.addIssue({
          code: "custom",
          path: ["companyName"],
          message: "Company name is required",
        });
      }
      if (!value.taxId) {
        ctx.addIssue({
          code: "custom",
          path: ["taxId"],
          message: "Tax ID is required",
        });
      }
    }
  }).strict();

const updateCustomerSchema = createCustomerSchema.partial().extend({
  defaultAddressId: z.string().uuid().optional().nullable(),
}).strict();

function sendError(reply: any, err: any, fallback: string) {
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: "Validation failed", issues: err.flatten() });
  }
  return reply.code(err?.statusCode ?? 500).send({ error: err?.message ?? fallback });
}

const customersFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/",
    { preHandler: fastifyAuth({ permission: "customers.read" }) },
    async (request, reply) => {
      try {
        const q = typeof (request.query as any)?.q === "string" ? (request.query as any).q : undefined;
        const rawType = typeof (request.query as any)?.type === "string" ? (request.query as any).type : undefined;
        const type =
          rawType && Object.values(CustomerType).includes(rawType as CustomerType)
            ? (rawType as CustomerType)
            : undefined;
        const page = (request.query as any)?.page ? Number((request.query as any).page) : undefined;
        const limit = (request.query as any)?.limit ? Number((request.query as any).limit) : undefined;
        const result = await listCustomerEntities(request.user!, {
          q,
          type,
          page,
          limit,
        });
        return reply.send(result);
      } catch (err: any) {
        return sendError(reply, err, "Failed to fetch customers");
      }
    },
  );

  fastify.get(
    "/:id",
    { preHandler: fastifyAuth({ permission: "customers.read" }) },
    async (request, reply) => {
      try {
        const id = String((request.params as any)?.id ?? "").trim();
        if (!id) return reply.code(400).send({ error: "Customer id is required" });

        const customer = await getCustomerEntityById(request.user!, id);
        if (!customer) return reply.code(404).send({ error: "Not found" });
        return reply.send(customer);
      } catch (err: any) {
        return sendError(reply, err, "Failed to fetch customer");
      }
    },
  );

  fastify.post(
    "/",
    { preHandler: fastifyAuth({ permission: "customers.write" }) },
    async (request, reply) => {
      try {
        const dto = createCustomerSchema.parse(request.body);
        const created = await createCustomerEntity(request.user!, {
          ...dto,
          type: dto.type as CustomerType,
        });
        return reply.code(201).send(created);
      } catch (err: any) {
        return sendError(reply, err, "Failed to create customer");
      }
    },
  );

  fastify.patch(
    "/:id",
    { preHandler: fastifyAuth({ permission: "customers.write" }) },
    async (request, reply) => {
      try {
        const id = String((request.params as any)?.id ?? "").trim();
        if (!id) return reply.code(400).send({ error: "Customer id is required" });
        const dto = updateCustomerSchema.parse(request.body);
        const updated = await updateCustomerEntity(request.user!, id, {
          ...dto,
          type: dto.type as CustomerType | undefined,
        });
        if (!updated) return reply.code(404).send({ error: "Not found" });
        return reply.send(updated);
      } catch (err: any) {
        return sendError(reply, err, "Failed to update customer");
      }
    },
  );

  fastify.delete(
    "/:id",
    { preHandler: fastifyAuth({ permission: "customers.write" }) },
    async (request, reply) => {
      try {
        const id = String((request.params as any)?.id ?? "").trim();
        if (!id) return reply.code(400).send({ error: "Customer id is required" });
        const deleted = await deleteCustomerEntity(request.user!, id);
        if (!deleted) return reply.code(404).send({ error: "Not found" });
        return reply.code(204).send();
      } catch (err: any) {
        return sendError(reply, err, "Failed to delete customer");
      }
    },
  );
};

export default customersFastifyRoutes;
