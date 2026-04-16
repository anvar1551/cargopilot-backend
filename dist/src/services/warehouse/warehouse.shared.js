"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WAREHOUSE_CAPABILITIES = exports.DEFAULT_WAREHOUSE_TYPE = exports.WAREHOUSE_TYPES = void 0;
exports.normalizeWarehouseType = normalizeWarehouseType;
exports.WAREHOUSE_TYPES = ["warehouse", "pickup_point"];
exports.DEFAULT_WAREHOUSE_TYPE = "warehouse";
exports.WAREHOUSE_CAPABILITIES = {
    warehouse: [
        "inbound_intake",
        "sorting",
        "outbound_dispatch",
        "linehaul_handoff",
        "driver_assignment",
    ],
    pickup_point: [
        "customer_dropoff",
        "customer_pickup",
        "local_batch_scan",
        "driver_assignment",
        "handoff_to_hub",
    ],
};
function normalizeWarehouseType(value) {
    const normalized = String(value || "")
        .trim()
        .replace(/[-\s]+/g, "_")
        .toLowerCase();
    return exports.WAREHOUSE_TYPES.includes(normalized)
        ? normalized
        : exports.DEFAULT_WAREHOUSE_TYPE;
}
