"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_WAREHOUSE_TYPE = exports.WAREHOUSE_TYPES = void 0;
exports.normalizeWarehouseType = normalizeWarehouseType;
exports.WAREHOUSE_TYPES = ["warehouse", "pickup_point"];
exports.DEFAULT_WAREHOUSE_TYPE = "warehouse";
function normalizeWarehouseType(value) {
    const normalized = String(value || "")
        .trim()
        .replace(/[-\s]+/g, "_")
        .toLowerCase();
    return exports.WAREHOUSE_TYPES.includes(normalized)
        ? normalized
        : exports.DEFAULT_WAREHOUSE_TYPE;
}
