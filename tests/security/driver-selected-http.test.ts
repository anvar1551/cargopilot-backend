jest.mock("../../src/modules/identity-access/transport/fastify-auth", () => ({ fastifyAuth: () => async () => undefined }));
jest.mock("../../src/modules/driver-core/application/driverProfileService", () => ({ listDriversView: jest.fn(), updateDriverProfileById: jest.fn() }));
jest.mock("../../src/modules/live-map-core/application/liveMapService", () => ({ getDriverPresence: jest.fn(), setDriverPresence: jest.fn(), heartbeatDriverPresence: jest.fn(), ingestDriverTelemetry: jest.fn(), ingestDriverLocation: jest.fn() }));
import Fastify from "fastify";
import routes from "../../src/modules/driver-core/transport/fastify-routes";
import * as service from "../../src/modules/live-map-core/application/liveMapService";
const actor: any = { id: "same-user", tenantId: "tenant-a", companyId: "company-a", tenantMembershipId: "tm-a", membershipId: "cm-a", companyMembershipId: "cm-a" };
beforeEach(() => jest.resetAllMocks());
async function appFor(authenticated = true) { const app = Fastify(); app.addHook("onRequest", async request => { if (authenticated) request.user = actor; }); await app.register(routes); return app; }
it.each([
  ["POST", "/location", "ingestDriverLocation"], ["POST", "/telemetry", "ingestDriverTelemetry"],
  ["GET", "/presence", "getDriverPresence"], ["PUT", "/presence", "setDriverPresence"],
  ["POST", "/presence/heartbeat", "heartbeatDriverPresence"],
] as const)("%s %s preserves all selected identity fields", async (method, url, name) => {
  const app = await appFor(); try { (service[name] as jest.Mock).mockResolvedValue({ ok: true }); const response = await app.inject({ method, url, ...(method === "GET" ? {} : { payload: { context: "synthetic" } }) }); expect(response.statusCode).toBe(200); if (method === "GET") expect(response.headers["cache-control"]).toBe("no-store"); expect(service[name]).toHaveBeenCalledWith(expect.objectContaining({ actor })); } finally { await app.close(); }
});
it("anonymous requests never invoke telemetry service", async () => {
  const app = await appFor(false); try { expect((await app.inject({ method: "POST", url: "/telemetry", payload: {} })).statusCode).toBe(401); expect(service.ingestDriverTelemetry).not.toHaveBeenCalled(); } finally { await app.close(); }
});
it.each([403, 409, 503, 500])("failed telemetry %s has no internal diagnostic exposure or false confirmation", async statusCode => {
  const app = await appFor(); try { (service.ingestDriverTelemetry as jest.Mock).mockRejectedValue(Object.assign(new Error("PRIVATE-CANARY"), { statusCode })); const response = await app.inject({ method: "POST", url: "/telemetry", payload: {} }); expect(response.statusCode).toBe(statusCode); expect(response.body).not.toContain("PRIVATE-CANARY"); expect(response.json()).not.toHaveProperty("ok", true); } finally { await app.close(); }
});
