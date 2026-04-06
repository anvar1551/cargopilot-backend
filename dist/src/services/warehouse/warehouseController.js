"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getWarehouse = exports.list = exports.create = void 0;
const warehouseRepo_1 = require("./warehouseRepo");
const create = async (req, res) => {
    try {
        const { name, location, region } = req.body;
        if (!name || !location) {
            return res.status(400).json({ error: "Name and location are required" });
        }
        const warehouse = await (0, warehouseRepo_1.createWarehouse)(name, location, region);
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
