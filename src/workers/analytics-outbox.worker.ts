import "dotenv/config";
import prisma from "../config/prismaClient";
import { analyticsLogger } from "../modules/analytics-core/config/analyticsLogger";
import { startAnalyticsOutboxPublisher } from "../modules/analytics-core/infrastructure/analyticsOutboxPublisher";

async function start() {
  analyticsLogger.info("analytics outbox worker starting");
  await startAnalyticsOutboxPublisher();
}

void start().catch((err) => {
  analyticsLogger.error("analytics outbox worker crashed", err);
  process.exitCode = 1;
});

process.on("SIGTERM", async () => {
  analyticsLogger.info("analytics outbox worker shutting down");
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
});

process.on("SIGINT", async () => {
  analyticsLogger.info("analytics outbox worker interrupted");
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
});

