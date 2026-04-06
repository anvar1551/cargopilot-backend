"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const os_1 = __importDefault(require("os"));
const workflow_1 = require("../services/orders/workflow");
function parsePositiveInt(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return fallback;
    return Math.floor(parsed);
}
const pollMs = parsePositiveInt(process.env.ORDER_LABEL_WORKER_POLL_MS, 2000);
const batchSize = parsePositiveInt(process.env.ORDER_LABEL_WORKER_BATCH_SIZE, 10);
const workerId = process.env.ORDER_LABEL_WORKER_ID ?? `${os_1.default.hostname()}-${process.pid}`;
let running = false;
let timer = null;
async function tick() {
    if (running)
        return;
    running = true;
    try {
        const result = await (0, workflow_1.runOrderLabelQueueTick)({ workerId, batchSize });
        if (result.claimed > 0 || result.failed > 0 || result.retried > 0) {
            console.log(`[order-label-worker] claimed=${result.claimed} completed=${result.completed} retried=${result.retried} failed=${result.failed}`);
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[order-label-worker] tick failed: ${message}`);
    }
    finally {
        running = false;
    }
}
async function shutdown(signal) {
    console.log(`[order-label-worker] received ${signal}, stopping...`);
    if (timer)
        clearInterval(timer);
    await Promise.resolve();
    process.exit(0);
}
async function main() {
    const runOnce = process.argv.includes("--once") || process.env.ORDER_LABEL_WORKER_ONCE === "true";
    console.log(`[order-label-worker] started workerId=${workerId} pollMs=${pollMs} batchSize=${batchSize} mode=${runOnce ? "once" : "loop"}`);
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
