import "dotenv/config";
import prisma from "../config/prismaClient";
import { logFinanceOutboxFailure } from "../modules/finance-core/infrastructure/finance-outbox-diagnostics";
import { startFinanceOutboxPublisher } from "../modules/finance-core/infrastructure/finance-outbox.publisher";

const controller = new AbortController();
void startFinanceOutboxPublisher({ signal: controller.signal }).catch(() => {
  logFinanceOutboxFailure("crash");
  process.exitCode = 1;
});

async function shutdown() {
  controller.abort();
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
