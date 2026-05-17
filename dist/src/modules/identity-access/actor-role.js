"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ROLE_MANAGER = exports.ROLE_WAREHOUSE = exports.ROLE_DRIVER = exports.ROLE_CUSTOMER = exports.ACTOR_ROLES = void 0;
exports.isActorRole = isActorRole;
exports.ACTOR_ROLES = [
    "customer",
    "driver",
    "warehouse",
    "manager",
];
const actorRoleSet = new Set(exports.ACTOR_ROLES);
function isActorRole(value) {
    return typeof value === "string" && actorRoleSet.has(value);
}
exports.ROLE_CUSTOMER = "customer";
exports.ROLE_DRIVER = "driver";
exports.ROLE_WAREHOUSE = "warehouse";
exports.ROLE_MANAGER = "manager";
