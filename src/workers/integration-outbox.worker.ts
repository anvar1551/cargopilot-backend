import "dotenv/config";
import prisma from "../config/prismaClient";
import { integrationOutboxLogger } from "../modules/integrations-core/config/outbox.logger";
import { startIntegrationOutboxPublisher } from "../modules/integrations-core/infrastructure/integration-outbox.publisher";

async function start() {
  integrationOutboxLogger.info("integration outbox worker boot");
  await startIntegrationOutboxPublisher();
}

void start().catch((error: any) => {
  integrationOutboxLogger.error("integration outbox worker crashed", {
    error: String(error?.message || error),
  });
  process.exitCode = 1;
});

async function shutdown(reason: string) {
  integrationOutboxLogger.info("integration outbox worker shutdown", { reason });
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

