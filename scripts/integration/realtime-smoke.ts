import { consumeSseUntil, getRequiredEnv, httpJson, logStep, login, pretty } from "./helpers";

type HealthResponse = {
  status: string;
  redis?: {
    enabled?: boolean;
    ok?: boolean | null;
    sharedClientStatus?: string;
    cooldownActive?: boolean;
  };
};

async function main() {
  const adminEmail = getRequiredEnv("INTEGRATION_ADMIN_EMAIL");
  const adminPassword = getRequiredEnv("INTEGRATION_ADMIN_PASSWORD");
  const driverEmail = String(process.env.INTEGRATION_DRIVER_EMAIL || "").trim();
  const driverPassword = String(process.env.INTEGRATION_DRIVER_PASSWORD || "").trim();

  logStep("Health check");
  const health = await httpJson<HealthResponse>({ path: "/api/health" });
  console.log(pretty({ status: health.status, redis: health.redis }));

  logStep("Admin login");
  const admin = await login(adminEmail, adminPassword);
  console.log("Admin token OK");

  logStep("Analytics SSE + manual refresh");
  let refreshTriggered = false;
  const analyticsEvents = await consumeSseUntil({
    path: "/api/analytics/stream",
    token: admin.token,
    timeoutMs: 20000,
    onEvent: async (evt) => {
      if (evt.event === "ready" && !refreshTriggered) {
        refreshTriggered = true;
        await httpJson({
          method: "POST",
          path: "/api/analytics/refresh",
          token: admin.token,
        });
      }
    },
    doneWhen: ({ events }) =>
      events.some((event) => event.event === "ready") &&
      events.some(
        (event) =>
          event.event === "analytics-refresh" &&
          typeof event.data === "object" &&
          event.data !== null &&
          (event.data as Record<string, unknown>).reason === "manual_refresh",
      ),
  });

  const analyticsSummary = {
    totalEvents: analyticsEvents.length,
    readyEvents: analyticsEvents.filter((e) => e.event === "ready").length,
    refreshEvents: analyticsEvents.filter((e) => e.event === "analytics-refresh").length,
  };
  console.log(pretty(analyticsSummary));

  logStep("Live-map SSE + telemetry");
  const telemetryActor = driverEmail && driverPassword ? await login(driverEmail, driverPassword) : admin;
  const telemetryDriverId =
    typeof telemetryActor.user?.userId === "string"
      ? telemetryActor.user.userId
      : typeof telemetryActor.user?.id === "string"
        ? telemetryActor.user.id
        : typeof admin.user?.userId === "string"
          ? admin.user.userId
          : typeof admin.user?.id === "string"
            ? admin.user.id
        : null;

  if (!telemetryDriverId) {
    throw new Error("Could not resolve telemetry actor user.id from login response");
  }

  const lat = 41.311 + Math.random() * 0.001;
  const lng = 69.279 + Math.random() * 0.001;
  let telemetryPosted = false;

  const liveMapEvents = await consumeSseUntil({
    path: `/api/live-map/stream?minLat=41.0&minLng=69.0&maxLat=42.0&maxLng=70.0`,
    token: admin.token,
    timeoutMs: 25000,
    onEvent: async (evt) => {
      if (evt.event === "ready" && !telemetryPosted) {
        telemetryPosted = true;
        await httpJson({
          method: "POST",
          path: "/api/drivers/telemetry",
          token: telemetryActor.token,
          body: {
            lat,
            lng,
            speedKmh: 28,
            headingDeg: 120,
            accuracyM: 10,
            recordedAt: new Date().toISOString(),
            ...(telemetryActor === admin ? { driverId: telemetryDriverId } : {}),
          },
        });
      }
    },
    doneWhen: ({ events }) =>
      events.some((event) => event.event === "ready") &&
      events.some((event) => {
        if (event.event !== "live-map") return false;
        const payload =
          typeof event.data === "object" && event.data !== null
            ? (event.data as Record<string, unknown>).payload
            : null;
        if (!payload || typeof payload !== "object") return false;
        return (payload as Record<string, unknown>).driverId === telemetryDriverId;
      }),
  });

  const liveMapSummary = {
    totalEvents: liveMapEvents.length,
    readyEvents: liveMapEvents.filter((e) => e.event === "ready").length,
    liveMapEvents: liveMapEvents.filter((e) => e.event === "live-map").length,
  };
  console.log(pretty(liveMapSummary));

  logStep("Realtime smoke passed");
}

void main().catch((err) => {
  console.error("[integration] realtime smoke failed:", err?.message || err);
  process.exitCode = 1;
});
