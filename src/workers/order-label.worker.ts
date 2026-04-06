import "dotenv/config";
import os from "os";

import { runOrderLabelQueueTick } from "../services/orders/workflow";

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

const pollMs = parsePositiveInt(process.env.ORDER_LABEL_WORKER_POLL_MS, 2000);
const batchSize = parsePositiveInt(process.env.ORDER_LABEL_WORKER_BATCH_SIZE, 10);
const workerId =
  process.env.ORDER_LABEL_WORKER_ID ?? `${os.hostname()}-${process.pid}`;

let running = false;
let timer: NodeJS.Timeout | null = null;

async function tick() {
  if (running) return;
  running = true;

  try {
    const result = await runOrderLabelQueueTick({ workerId, batchSize });

    if (result.claimed > 0 || result.failed > 0 || result.retried > 0) {
      console.log(
        `[order-label-worker] claimed=${result.claimed} completed=${result.completed} retried=${result.retried} failed=${result.failed}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[order-label-worker] tick failed: ${message}`);
  } finally {
    running = false;
  }
}

async function shutdown(signal: string) {
  console.log(`[order-label-worker] received ${signal}, stopping...`);
  if (timer) clearInterval(timer);
  await Promise.resolve();
  process.exit(0);
}

async function main() {
  const runOnce = process.argv.includes("--once") || process.env.ORDER_LABEL_WORKER_ONCE === "true";

  console.log(
    `[order-label-worker] started workerId=${workerId} pollMs=${pollMs} batchSize=${batchSize} mode=${runOnce ? "once" : "loop"}`,
  );

  await tick();

  if (runOnce) {
    process.exit(0);
  }

  timer = setInterval(() => {
    void tick();
  }, pollMs);

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

void main();
