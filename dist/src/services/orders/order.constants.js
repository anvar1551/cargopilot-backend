"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_SERVICE_TYPE = exports.SERVICE_TYPES = void 0;
exports.normalizeServiceTypeInput = normalizeServiceTypeInput;
exports.SERVICE_TYPES = [
    "DOOR_TO_DOOR",
    "DOOR_TO_POINT",
    "POINT_TO_DOOR",
    "POINT_TO_POINT",
];
exports.DEFAULT_SERVICE_TYPE = "DOOR_TO_DOOR";
const LEGACY_TO_SERVICE_TYPE = {
    DOOR_TO_DOOR: "DOOR_TO_DOOR",
    "DOOR TO DOOR": "DOOR_TO_DOOR",
    EXPRESS: "DOOR_TO_DOOR",
    SAME_DAY: "DOOR_TO_DOOR",
    "SAME DAY": "DOOR_TO_DOOR",
    ECONOMY: "DOOR_TO_DOOR",
    DOOR_TO_POINT: "DOOR_TO_POINT",
    "DOOR TO POINT": "DOOR_TO_POINT",
    POINT_TO_DOOR: "POINT_TO_DOOR",
    "POINT TO DOOR": "POINT_TO_DOOR",
    POINT_TO_POINT: "POINT_TO_POINT",
    "POINT TO POINT": "POINT_TO_POINT",
};
function normalizeServiceTypeInput(value) {
    const normalized = String(value || "")
        .trim()
        .replace(/-/g, "_")
        .replace(/\s+/g, "_")
        .toUpperCase();
    return LEGACY_TO_SERVICE_TYPE[normalized] ?? exports.DEFAULT_SERVICE_TYPE;
}
