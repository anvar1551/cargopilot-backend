import { FastifyPluginAsync } from "fastify";
import { fastifyAuth } from "../../../modules/identity-access/transport/fastify-auth";
import {
  createWarehouse,
  getWarehouseById,
  listWarehouses,
  updateWarehouse,
} from "../application/warehouseRepo";
import { normalizeWarehouseType } from "../application/warehouse.shared";
import { warehouseView, warehouseDetailView } from "../application/warehouseProjection";
import { rejectWarehouseFields } from "../application/warehouseAccess";
import prisma from "../../../config/prismaClient";
import { readWarehouseProvisioningAuthority } from "../application/warehouseProvisioning";

function sendWarehouseError(reply: any, error: any, fallback: string) {
  if (error?.code === "P2025") return reply.code(404).send({ error: "Warehouse not found" });
  if ([400, 403, 404, 409].includes(error?.statusCode)) return reply.code(error.statusCode).send({ error: error.message });
  return reply.code(500).send({ error: fallback });
}

function parseCoordinate(value: unknown, axis: "lat" | "lng") {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (axis === "lat") return parsed >= -90 && parsed <= 90 ? parsed : null;
  return parsed >= -180 && parsed <= 180 ? parsed : null;
}

const warehouseFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/provisioning-authority", { onRequest: async (_request, reply) => { reply.header("Cache-Control", "no-store"); }, preHandler: fastifyAuth({ permission: "warehouse.create" }) }, async (request, reply) => {
    try { return await readWarehouseProvisioningAuthority(prisma, request.user!); }
    catch (error) { return sendWarehouseError(reply, error, "Failed to read warehouse provisioning authority"); }
  });
  fastify.post(
    "/",
    { preHandler: fastifyAuth({ permission: "warehouse.create" }) },
    async (request, reply) => {
      try {
        const warehouse = await createWarehouse(request.user!, request.body);

        return reply.code(201).send(warehouseView(warehouse));
      } catch (error) {
        request.log.error({ requestId: request.id }, "createWarehouse failed");
        return sendWarehouseError(reply, error, "Failed to create warehouse");
      }
    },
  );

  fastify.get(
    "/",
    { preHandler: fastifyAuth({ permission: "shipment.view" }) },
    async (request, reply) => {
      try {
        const query = (request.query ?? {}) as Record<string, unknown>;
        const warehouses = await listWarehouses(request.user!, { search: query.search as string | undefined,
          page: query.page === undefined ? undefined : Number(query.page), limit: query.limit === undefined ? undefined : Number(query.limit) });
        return reply.send(warehouses.map(warehouseView));
      } catch (error) {
        request.log.error({ requestId: request.id }, "listWarehouses failed");
        return sendWarehouseError(reply, error, "Failed to fetch warehouses");
      }
    },
  );

  fastify.get(
    "/:id",
    { preHandler: fastifyAuth({ permission: "shipment.view" }) },
    async (request, reply) => {
      try {
        const id = String((request.params as any)?.id || "").trim();
        const warehouse = await getWarehouseById(request.user!, id);
        if (!warehouse) return reply.code(404).send({ error: "Warehouse not found" });
        return reply.send(warehouseDetailView(warehouse));
      } catch (error) {
        request.log.error({ requestId: request.id }, "getWarehouse failed");
        return sendWarehouseError(reply, error, "Failed to fetch warehouse");
      }
    },
  );

  fastify.put(
    "/:id",
    { preHandler: fastifyAuth({ permission: "shipment.update" }) },
    async (request, reply) => {
      try {
        const id = String((request.params as any)?.id || "").trim();
        const body = (request.body ?? {}) as Record<string, unknown>;
        rejectWarehouseFields(body);
        const name = String(body.name || "").trim();
        const location = String(body.location || "").trim();
        if (!id) return reply.code(400).send({ error: "Warehouse id is required" });
        if (!name || !location) {
          return reply.code(400).send({ error: "Name and location are required" });
        }

        const warehouse = await updateWarehouse(request.user!, id, {
          name,
          type: normalizeWarehouseType(typeof body.type === "string" ? body.type : undefined),
          location,
          region: typeof body.region === "string" && body.region.trim() ? body.region.trim() : null,
          latitude: parseCoordinate(body.latitude, "lat"),
          longitude: parseCoordinate(body.longitude, "lng"),
        });

        return reply.send(warehouseView(warehouse));
      } catch (error: any) {
        if (error?.code === "P2025") {
          return reply.code(404).send({ error: "Warehouse not found" });
        }
        request.log.error({ requestId: request.id }, "updateWarehouse failed");
        return sendWarehouseError(reply, error, "Failed to update warehouse");
      }
    },
  );
};

export default warehouseFastifyRoutes;

