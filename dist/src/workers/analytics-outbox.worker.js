"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const prismaClient_1 = __importDefault(require("../config/prismaClient"));
const analyticsLogger_1 = require("../modules/analytics-core/config/analyticsLogger");
const analyticsOutboxPublisher_1 = require("../modules/analytics-core/infrastructure/analyticsOutboxPublisher");
async function start() {
    analyticsLogger_1.analyticsLogger.info("analytics outbox worker starting");
    await (0, analyticsOutboxPublisher_1.startAnalyticsOutboxPublisher)();
}
void start().catch((err) => {
    analyticsLogger_1.analyticsLogger.error("analytics outbox worker crashed", err);
    process.exitCode = 1;
});
process.on("SIGTERM", async () => {
    analyticsLogger_1.analyticsLogger.info("analytics outbox worker shutting down");
    await prismaClient_1.default.$disconnect().catch(() => undefined);
    process.exit(0);
});
process.on("SIGINT", async () => {
    analyticsLogger_1.analyticsLogger.info("analytics outbox worker interrupted");
    await prismaClient_1.default.$disconnect().catch(() => undefined);
    process.exit(0);
});
