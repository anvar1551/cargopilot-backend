"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const authFastify_1 = require("../../../middleware/authFastify");
const warehouseRepo_1 = require("../application/warehouseRepo");
const warehouse_shared_1 = require("../application/warehouse.shared");
function parseCoordinate(value, axis) {
    if (value == null || value === "")
        return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return null;
    if (axis === "lat")
        return parsed >= -90 && parsed <= 90 ? parsed : null;
    return parsed >= -180 && parsed <= 180 ? parsed : null;
}
const warehouseFastifyRoutes = async (fastify) => {
    fastify.post("/", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.write" }) }, async (request, reply) => {
        try {
            const body = (request.body ?? {});
            const name = String(body.name || "").trim();
            const location = String(body.location || "").trim();
            if (!name || !location) {
                return reply.code(400).send({ error: "Name and location are required" });
            }
            const warehouse = await (0, warehouseRepo_1.createWarehouse)(name, (0, warehouse_shared_1.normalizeWarehouseType)(typeof body.type === "string" ? body.type : undefined), location, typeof body.region === "string" && body.region.trim() ? body.region.trim() : undefined, parseCoordinate(body.latitude, "lat"), parseCoordinate(body.longitude, "lng"));
            return reply.code(201).send(warehouse);
        }
        catch (error) {
            console.error("createWarehouse error:", error);
            return reply.code(500).send({ error: "Failed to create warehouse" });
        }
    });
    fastify.get("/", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.read" }) }, async (_request, reply) => {
        try {
            const warehouses = await (0, warehouseRepo_1.listWarehouses)();
            return reply.send(warehouses);
        }
        catch (error) {
            console.error("listWarehouses error:", error);
            return reply.code(500).send({ error: "Failed to fetch warehouses" });
        }
    });
    fastify.get("/:id", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.read" }) }, async (request, reply) => {
        try {
            const id = String(request.params?.id || "").trim();
            const warehouse = await (0, warehouseRepo_1.getWarehouseById)(id);
            if (!warehouse)
                return reply.code(404).send({ error: "Warehouse not found" });
            return reply.send(warehouse);
        }
        catch (error) {
            console.error("getWarehouse error:", error);
            return reply.code(500).send({ error: "Failed to fetch warehouse" });
        }
    });
    fastify.put("/:id", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.write" }) }, async (request, reply) => {
        try {
            const id = String(request.params?.id || "").trim();
            const body = (request.body ?? {});
            const name = String(body.name || "").trim();
            const location = String(body.location || "").trim();
            if (!id)
                return reply.code(400).send({ error: "Warehouse id is required" });
            if (!name || !location) {
                return reply.code(400).send({ error: "Name and location are required" });
            }
            const warehouse = await (0, warehouseRepo_1.updateWarehouse)(id, {
                name,
                type: (0, warehouse_shared_1.normalizeWarehouseType)(typeof body.type === "string" ? body.type : undefined),
                location,
                region: typeof body.region === "string" && body.region.trim() ? body.region.trim() : null,
                latitude: parseCoordinate(body.latitude, "lat"),
                longitude: parseCoordinate(body.longitude, "lng"),
            });
            return reply.send(warehouse);
        }
        catch (error) {
            if (error?.code === "P2025") {
                return reply.code(404).send({ error: "Warehouse not found" });
            }
            console.error("updateWarehouse error:", error);
            return reply.code(500).send({ error: "Failed to update warehouse" });
        }
    });
};
exports.default = warehouseFastifyRoutes;
