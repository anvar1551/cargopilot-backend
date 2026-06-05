import { FastifyPluginAsync } from "fastify";
import { fastifyAuth } from "../../../modules/identity-access/transport/fastify-auth";
import {
  createWarehouse,
  getWarehouseById,
  listWarehouses,
  updateWarehouse,
} from "../application/warehouseRepo";
import { normalizeWarehouseType } from "../application/warehouse.shared";

function parseCoordinate(value: unknown, axis: "lat" | "lng") {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (axis === "lat") return parsed >= -90 && parsed <= 90 ? parsed : null;
  return parsed >= -180 && parsed <= 180 ? parsed : null;
}

const warehouseFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/",
    { preHandler: fastifyAuth({ permission: "shipment.update" }) },
    async (request, reply) => {
      try {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const name = String(body.name || "").trim();
        const location = String(body.location || "").trim();
        if (!name || !location) {
          return reply.code(400).send({ error: "Name and location are required" });
        }

        const warehouse = await createWarehouse(
          name,
          normalizeWarehouseType(typeof body.type === "string" ? body.type : undefined),
          location,
          typeof body.region === "string" && body.region.trim() ? body.region.trim() : undefined,
          parseCoordinate(body.latitude, "lat"),
          parseCoordinate(body.longitude, "lng"),
        );

        return reply.code(201).send(warehouse);
      } catch (error) {
        console.error("createWarehouse error:", error);
        return reply.code(500).send({ error: "Failed to create warehouse" });
      }
    },
  );

  fastify.get(
    "/",
    { preHandler: fastifyAuth({ permission: "shipment.view" }) },
    async (_request, reply) => {
      try {
        const warehouses = await listWarehouses();
        return reply.send(warehouses);
      } catch (error) {
        console.error("listWarehouses error:", error);
        return reply.code(500).send({ error: "Failed to fetch warehouses" });
      }
    },
  );

  fastify.get(
    "/:id",
    { preHandler: fastifyAuth({ permission: "shipment.view" }) },
    async (request, reply) => {
      try {
        const id = String((request.params as any)?.id || "").trim();
        const warehouse = await getWarehouseById(id);
        if (!warehouse) return reply.code(404).send({ error: "Warehouse not found" });
        return reply.send(warehouse);
      } catch (error) {
        console.error("getWarehouse error:", error);
        return reply.code(500).send({ error: "Failed to fetch warehouse" });
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
        const name = String(body.name || "").trim();
        const location = String(body.location || "").trim();
        if (!id) return reply.code(400).send({ error: "Warehouse id is required" });
        if (!name || !location) {
          return reply.code(400).send({ error: "Name and location are required" });
        }

        const warehouse = await updateWarehouse(id, {
          name,
          type: normalizeWarehouseType(typeof body.type === "string" ? body.type : undefined),
          location,
          region: typeof body.region === "string" && body.region.trim() ? body.region.trim() : null,
          latitude: parseCoordinate(body.latitude, "lat"),
          longitude: parseCoordinate(body.longitude, "lng"),
        });

        return reply.send(warehouse);
      } catch (error: any) {
        if (error?.code === "P2025") {
          return reply.code(404).send({ error: "Warehouse not found" });
        }
        console.error("updateWarehouse error:", error);
        return reply.code(500).send({ error: "Failed to update warehouse" });
      }
    },
  );
};

export default warehouseFastifyRoutes;

