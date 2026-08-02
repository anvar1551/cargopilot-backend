"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const child_process_1 = require("child_process");
const util_1 = require("util");
const helpers_1 = require("./helpers");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
async function runDocker(args) {
    const result = await execFileAsync("docker", args, { windowsHide: true });
    return {
        stdout: String(result.stdout || "").trim(),
        stderr: String(result.stderr || "").trim(),
    };
}
async function pollHealthUntil(args) {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < args.timeoutMs) {
        try {
            last = await (0, helpers_1.httpJson)({ path: "/api/health" });
            const redisOk = Boolean(last.redis?.ok);
            if (args.expectRedisOk ? redisOk : !redisOk)
                return last;
        }
        catch {
            // keep polling
        }
        await (0, helpers_1.sleep)(args.intervalMs);
    }
    throw new Error(`Health did not reach expectRedisOk=${args.expectRedisOk}. Last health: ${(0, helpers_1.pretty)(last)}`);
}
async function main() {
    const redisContainer = (0, helpers_1.getRequiredEnv)("REDIS_CONTAINER");
    const adminEmail = (0, helpers_1.getRequiredEnv)("INTEGRATION_ADMIN_EMAIL");
    const adminPassword = (0, helpers_1.getRequiredEnv)("INTEGRATION_ADMIN_PASSWORD");
    let redisStopped = false;
    try {
        (0, helpers_1.logStep)("Admin login");
        const admin = await (0, helpers_1.login)(adminEmail, adminPassword);
        console.log("Admin token OK");
        (0, helpers_1.logStep)("Baseline health");
        const before = await (0, helpers_1.httpJson)({ path: "/api/health" });
        console.log((0, helpers_1.pretty)(before));
        (0, helpers_1.logStep)("Baseline analytics endpoint (must respond)");
        await (0, helpers_1.httpJson)({ path: "/api/analytics/summary", token: admin.token });
        console.log("/api/analytics/summary OK");
        (0, helpers_1.logStep)(`Stopping redis container: ${redisContainer}`);
        await runDocker(["stop", redisContainer]);
        redisStopped = true;
        (0, helpers_1.logStep)("Wait until health reports redis degraded/unavailable");
        const down = await pollHealthUntil({
            expectRedisOk: false,
            timeoutMs: 45000,
            intervalMs: 1500,
        });
        console.log((0, helpers_1.pretty)(down));
        (0, helpers_1.logStep)("API fallback check while redis is down");
        await (0, helpers_1.httpJson)({ path: "/api/analytics/summary", token: admin.token });
        await (0, helpers_1.httpJson)({
            path: "/api/live-map/snapshot?minLat=41.0&minLng=69.0&maxLat=42.0&maxLng=70.0",
            token: admin.token,
        });
        console.log("Fallback endpoints still responding");
        (0, helpers_1.logStep)(`Starting redis container: ${redisContainer}`);
        await runDocker(["start", redisContainer]);
        redisStopped = false;
        (0, helpers_1.logStep)("Wait until health reports redis OK again");
        const up = await pollHealthUntil({
            expectRedisOk: true,
            timeoutMs: 60000,
            intervalMs: 2000,
        });
        console.log((0, helpers_1.pretty)(up));
        (0, helpers_1.logStep)("Post-recovery analytics/live-map checks");
        await (0, helpers_1.httpJson)({ path: "/api/analytics/summary", token: admin.token });
        await (0, helpers_1.httpJson)({
            path: "/api/live-map/snapshot?minLat=41.0&minLng=69.0&maxLat=42.0&maxLng=70.0",
            token: admin.token,
        });
        (0, helpers_1.logStep)("Redis resilience smoke passed");
    }
    finally {
        if (redisStopped) {
            try {
                (0, helpers_1.logStep)(`Recovery safeguard: starting redis container ${redisContainer}`);
                await runDocker(["start", redisContainer]);
            }
            catch {
                // noop
            }
        }
    }
}
void main().catch((err) => {
    console.error("[integration] redis resilience failed:", err?.message || err);
    process.exitCode = 1;
});
