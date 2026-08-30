import "dotenv/config";
import prisma from "../config/prismaClient";
import { startFinanceOutboxPublisher } from "../modules/finance-core/infrastructure/finance-outbox.publisher";

void startFinanceOutboxPublisher().catch((error) => {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    scope: "finance-outbox",
    level: "error",
    message: "finance outbox worker crashed",
    error: String(error?.message || error),
  }));
  process.exitCode = 1;
});

async function shutdown() {
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
