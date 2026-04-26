"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.update = exports.getWarehouse = exports.list = exports.create = void 0;
const warehouseRepo_1 = require("./warehouseRepo");
const warehouse_shared_1 = require("./warehouse.shared");
function parseCoordinate(value, axis) {
    if (value == null || value === "")
        return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return null;
    if (axis === "lat") {
        return parsed >= -90 && parsed <= 90 ? parsed : null;
    }
    return parsed >= -180 && parsed <= 180 ? parsed : null;
}
const create = async (req, res) => {
    try {
        const { name, type, location, region, latitude, longitude } = req.body;
        if (!name || !location) {
            return res.status(400).json({ error: "Name and location are required" });
        }
        const warehouse = await (0, warehouseRepo_1.createWarehouse)(name, (0, warehouse_shared_1.normalizeWarehouseType)(type), location, region, parseCoordinate(latitude, "lat"), parseCoordinate(longitude, "lng"));
        return res.status(201).json(warehouse);
    }
    catch (error) {
        console.error("createWarehouse error:", error);
        return res.status(500).json({ error: "Failed to create warehouse" });
    }
};
exports.create = create;
const list = async (_req, res) => {
    try {
        const warehouses = await (0, warehouseRepo_1.listWarehouses)();
        return res.json(warehouses);
    }
    catch (error) {
        console.error("listWarehouses error:", error);
        return res.status(500).json({ error: "Failed to fetch warehouses" });
    }
};
exports.list = list;
const getWarehouse = async (req, res) => {
    try {
        const { id } = req.params;
        const warehouse = await (0, warehouseRepo_1.getWarehouseById)(id);
        if (!warehouse)
            return res.status(404).json({ error: "Warehouse not found" });
        return res.json(warehouse);
    }
    catch (error) {
        console.error("getWarehouse error:", error);
        return res.status(500).json({ error: "Failed to fetch warehouse" });
    }
};
exports.getWarehouse = getWarehouse;
const update = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, type, location, region, latitude, longitude } = req.body;
        if (!id) {
            return res.status(400).json({ error: "Warehouse id is required" });
        }
        if (!name || !location) {
            return res.status(400).json({ error: "Name and location are required" });
        }
        const warehouse = await (0, warehouseRepo_1.updateWarehouse)(id, {
            name: String(name).trim(),
            type: (0, warehouse_shared_1.normalizeWarehouseType)(type),
            location: String(location).trim(),
            region: typeof region === "string" && region.trim().length > 0
                ? region.trim()
                : null,
            latitude: parseCoordinate(latitude, "lat"),
            longitude: parseCoordinate(longitude, "lng"),
        });
        return res.json(warehouse);
    }
    catch (error) {
        if (error?.code === "P2025") {
            return res.status(404).json({ error: "Warehouse not found" });
        }
        console.error("updateWarehouse error:", error);
        return res.status(500).json({ error: "Failed to update warehouse" });
    }
};
exports.update = update;
