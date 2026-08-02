"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const helpers_1 = require("./helpers");
async function main() {
    const adminEmail = (0, helpers_1.getRequiredEnv)("INTEGRATION_ADMIN_EMAIL");
    const adminPassword = (0, helpers_1.getRequiredEnv)("INTEGRATION_ADMIN_PASSWORD");
    const driverEmail = String(process.env.INTEGRATION_DRIVER_EMAIL || "").trim();
    const driverPassword = String(process.env.INTEGRATION_DRIVER_PASSWORD || "").trim();
    (0, helpers_1.logStep)("Health check");
    const health = await (0, helpers_1.httpJson)({ path: "/api/health" });
    console.log((0, helpers_1.pretty)({ status: health.status, redis: health.redis }));
    (0, helpers_1.logStep)("Admin login");
    const admin = await (0, helpers_1.login)(adminEmail, adminPassword);
    console.log("Admin token OK");
    (0, helpers_1.logStep)("Analytics SSE + manual refresh");
    let refreshTriggered = false;
    const analyticsEvents = await (0, helpers_1.consumeSseUntil)({
        path: "/api/analytics/stream",
        token: admin.token,
        timeoutMs: 20000,
        onEvent: async (evt) => {
            if (evt.event === "ready" && !refreshTriggered) {
                refreshTriggered = true;
                await (0, helpers_1.httpJson)({
                    method: "POST",
                    path: "/api/analytics/refresh",
                    token: admin.token,
                });
            }
        },
        doneWhen: ({ events }) => events.some((event) => event.event === "ready") &&
            events.some((event) => event.event === "analytics-refresh" &&
                typeof event.data === "object" &&
                event.data !== null &&
                event.data.reason === "manual_refresh"),
    });
    const analyticsSummary = {
        totalEvents: analyticsEvents.length,
        readyEvents: analyticsEvents.filter((e) => e.event === "ready").length,
        refreshEvents: analyticsEvents.filter((e) => e.event === "analytics-refresh").length,
    };
    console.log((0, helpers_1.pretty)(analyticsSummary));
    (0, helpers_1.logStep)("Live-map SSE + telemetry");
    const telemetryActor = driverEmail && driverPassword ? await (0, helpers_1.login)(driverEmail, driverPassword) : admin;
    const telemetryDriverId = typeof telemetryActor.user?.userId === "string"
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
    const liveMapEvents = await (0, helpers_1.consumeSseUntil)({
        path: `/api/live-map/stream?minLat=41.0&minLng=69.0&maxLat=42.0&maxLng=70.0`,
        token: admin.token,
        timeoutMs: 25000,
        onEvent: async (evt) => {
            if (evt.event === "ready" && !telemetryPosted) {
                telemetryPosted = true;
                await (0, helpers_1.httpJson)({
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
        doneWhen: ({ events }) => events.some((event) => event.event === "ready") &&
            events.some((event) => {
                if (event.event !== "live-map")
                    return false;
                const payload = typeof event.data === "object" && event.data !== null
                    ? event.data.payload
                    : null;
                if (!payload || typeof payload !== "object")
                    return false;
                return payload.driverId === telemetryDriverId;
            }),
    });
    const liveMapSummary = {
        totalEvents: liveMapEvents.length,
        readyEvents: liveMapEvents.filter((e) => e.event === "ready").length,
        liveMapEvents: liveMapEvents.filter((e) => e.event === "live-map").length,
    };
    console.log((0, helpers_1.pretty)(liveMapSummary));
    (0, helpers_1.logStep)("Realtime smoke passed");
}
void main().catch((err) => {
    console.error("[integration] realtime smoke failed:", err?.message || err);
    process.exitCode = 1;
});
