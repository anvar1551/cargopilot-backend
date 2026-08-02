"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const prismaClient_1 = __importDefault(require("../config/prismaClient"));
const iam_service_1 = require("../modules/identity-access/application/iam.service");
async function main() {
    await (0, iam_service_1.seedSystemPermissions)();
    const permissionCount = await prismaClient_1.default.permission.count();
    const ownerRoleCount = await prismaClient_1.default.role.count({
        where: { isSystem: true, isOwnerRole: true },
    });
    console.log(`[seed-permissions] synced permissions=${permissionCount} ownerRoles=${ownerRoleCount}`);
}
main()
    .catch((err) => {
    console.error("[seed-permissions] failed", err);
    process.exitCode = 1;
})
    .finally(async () => {
    await prismaClient_1.default.$disconnect().catch(() => undefined);
});
