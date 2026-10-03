jest.mock("../../src/modules/identity-access/transport/fastify-auth", () => ({ fastifyAuth: () => async () => undefined }));
jest.mock("../../src/modules/driver-core/application/driverProfileService", () => ({ listDriversView: jest.fn(), updateDriverProfileById: jest.fn() }));
jest.mock("../../src/modules/live-map-core/application/liveMapService", () => ({}));
import Fastify from "fastify";
import { ZodError } from "zod";
import routes from "../../src/modules/driver-core/transport/fastify-routes";
import { listDriversView, updateDriverProfileById } from "../../src/modules/driver-core/application/driverProfileService";
const user: any = { id: "synthetic-user", tenantId: "tenant-a", companyId: "company-a", companyMembershipId: "cm-a", membershipId: "cm-a", tenantMembershipId: "tm-a" };
beforeEach(() => jest.resetAllMocks());
async function appFor(authenticated = true) { const app = Fastify(); app.addHook("onRequest", async request => { if (authenticated) request.user = user; }); await app.register(routes); return app; }
it("directory forwards selected context and bounded filters with no-store", async () => {
  const app = await appFor(); try { (listDriversView as jest.Mock).mockResolvedValue([]); const response = await app.inject({ method: "GET", url: "/?limit=5" }); expect(response.statusCode).toBe(200); expect(response.headers["cache-control"]).toBe("no-store"); expect(listDriversView).toHaveBeenCalledWith(user, { limit: "5" }); } finally { await app.close(); }
});
it("profile route passes context and describes containment without raw internal errors", async () => {
  const app = await appFor(); try { (updateDriverProfileById as jest.Mock).mockRejectedValue(Object.assign(new Error("PRIVATE-CANARY"), { statusCode: 409 })); const response = await app.inject({ method: "PUT", url: "/driver-id", payload: { driverType: "linehaul" } }); expect(response.statusCode).toBe(409); expect(updateDriverProfileById).toHaveBeenCalledWith("driver-id", { driverType: "linehaul" }, user); expect(response.body).not.toContain("PRIVATE-CANARY"); } finally { await app.close(); }
});
it.each([403, 404, 500])("directory %s fails safely", async statusCode => {
  const app = await appFor(); try { (listDriversView as jest.Mock).mockRejectedValue(Object.assign(new Error("PRIVATE-CANARY"), { statusCode })); const response = await app.inject({ method: "GET", url: "/" }); expect(response.statusCode).toBe(statusCode); expect(response.body).not.toContain("PRIVATE-CANARY"); } finally { await app.close(); }
});
it("anonymous directory requests fail before service queries", async () => {
  const app = await appFor(false); try { expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(401); expect(listDriversView).not.toHaveBeenCalled(); } finally { await app.close(); }
});
it("invalid directory filters produce a safe400 rather than an internal-error response", async () => {
  const app = await appFor(); try { (listDriversView as jest.Mock).mockRejectedValue(new ZodError([{ code: "custom", path: ["limit"], message: "PRIVATE-CANARY" }])); const response = await app.inject({ method: "GET", url: "/?limit=101" }); expect(response.statusCode).toBe(400); expect(response.body).not.toContain("PRIVATE-CANARY"); } finally { await app.close(); }
});
