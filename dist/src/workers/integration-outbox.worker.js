"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const prismaClient_1 = __importDefault(require("../config/prismaClient"));
const outbox_logger_1 = require("../modules/integrations-core/config/outbox.logger");
const integration_outbox_publisher_1 = require("../modules/integrations-core/infrastructure/integration-outbox.publisher");
async function start() {
    outbox_logger_1.integrationOutboxLogger.info("integration outbox worker boot");
    await (0, integration_outbox_publisher_1.startIntegrationOutboxPublisher)();
}
void start().catch((error) => {
    outbox_logger_1.integrationOutboxLogger.error("integration outbox worker crashed", {
        error: String(error?.message || error),
    });
    process.exitCode = 1;
});
async function shutdown(reason) {
    outbox_logger_1.integrationOutboxLogger.info("integration outbox worker shutdown", { reason });
    await prismaClient_1.default.$disconnect().catch(() => undefined);
    process.exit(0);
}
process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
    void shutdown("SIGINT");
});
