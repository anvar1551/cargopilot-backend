import { execFile } from "child_process";
import { promisify } from "util";
import { getRequiredEnv, httpJson, logStep, login, pretty, sleep } from "./helpers";

const execFileAsync = promisify(execFile);

type HealthResponse = {
  status: string;
  redis?: {
    enabled?: boolean;
    ok?: boolean | null;
    sharedClientStatus?: string;
    cooldownActive?: boolean;
    cooldownRemainingMs?: number;
  };
};

async function runDocker(args: string[]) {
  const result = await execFileAsync("docker", args, { windowsHide: true });
  return {
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
  };
}

async function pollHealthUntil(args: {
  expectRedisOk: boolean;
  timeoutMs: number;
  intervalMs: number;
}) {
  const started = Date.now();
  let last: HealthResponse | null = null;
  while (Date.now() - started < args.timeoutMs) {
    try {
      last = await httpJson<HealthResponse>({ path: "/api/health" });
      const redisOk = Boolean(last.redis?.ok);
      if (args.expectRedisOk ? redisOk : !redisOk) return last;
    } catch {
      // keep polling
    }
    await sleep(args.intervalMs);
  }
  throw new Error(
    `Health did not reach expectRedisOk=${args.expectRedisOk}. Last health: ${pretty(last)}`,
  );
}

async function main() {
  const redisContainer = getRequiredEnv("REDIS_CONTAINER");
  const adminEmail = getRequiredEnv("INTEGRATION_ADMIN_EMAIL");
  const adminPassword = getRequiredEnv("INTEGRATION_ADMIN_PASSWORD");
  let redisStopped = false;

  try {
    logStep("Admin login");
    const admin = await login(adminEmail, adminPassword);
    console.log("Admin token OK");

    logStep("Baseline health");
    const before = await httpJson<HealthResponse>({ path: "/api/health" });
    console.log(pretty(before));

    logStep("Baseline analytics endpoint (must respond)");
    await httpJson({ path: "/api/analytics/summary", token: admin.token });
    console.log("/api/analytics/summary OK");

    logStep(`Stopping redis container: ${redisContainer}`);
    await runDocker(["stop", redisContainer]);
    redisStopped = true;

    logStep("Wait until health reports redis degraded/unavailable");
    const down = await pollHealthUntil({
      expectRedisOk: false,
      timeoutMs: 45_000,
      intervalMs: 1500,
    });
    console.log(pretty(down));

    logStep("API fallback check while redis is down");
    await httpJson({ path: "/api/analytics/summary", token: admin.token });
    await httpJson({
      path: "/api/live-map/snapshot?minLat=41.0&minLng=69.0&maxLat=42.0&maxLng=70.0",
      token: admin.token,
    });
    console.log("Fallback endpoints still responding");

    logStep(`Starting redis container: ${redisContainer}`);
    await runDocker(["start", redisContainer]);
    redisStopped = false;

    logStep("Wait until health reports redis OK again");
    const up = await pollHealthUntil({
      expectRedisOk: true,
      timeoutMs: 60_000,
      intervalMs: 2000,
    });
    console.log(pretty(up));

    logStep("Post-recovery analytics/live-map checks");
    await httpJson({ path: "/api/analytics/summary", token: admin.token });
    await httpJson({
      path: "/api/live-map/snapshot?minLat=41.0&minLng=69.0&maxLat=42.0&maxLng=70.0",
      token: admin.token,
    });

    logStep("Redis resilience smoke passed");
  } finally {
    if (redisStopped) {
      try {
        logStep(`Recovery safeguard: starting redis container ${redisContainer}`);
        await runDocker(["start", redisContainer]);
      } catch {
        // noop
      }
    }
  }
}

void main().catch((err) => {
  console.error("[integration] redis resilience failed:", err?.message || err);
  process.exitCode = 1;
});
