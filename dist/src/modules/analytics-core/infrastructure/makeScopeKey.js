"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeScopeKey = makeScopeKey;
function makeScopeKey(args) {
    if (args.role === "warehouse" && args.warehouseId) {
        return `warehouse:${args.warehouseId}`;
    }
    return `role:${args.role || "global"}`;
}
