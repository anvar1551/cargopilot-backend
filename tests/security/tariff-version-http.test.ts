jest.mock("../../src/modules/identity-access/transport/fastify-auth", () => ({ fastifyAuth: (options: any) => async (request: any, reply: any) => {
  mockPermissions.push(options.permission); if (!mockAuthenticated) return reply.code(401).send({ error: "Unauthorized" }); request.user = mockActor;
} }));
jest.mock("../../src/modules/pricing-core/repo/tariff-versions", () => ({ proposeTariffVersion: jest.fn(), decideTariffVersion: jest.fn(), readTariffVersion: jest.fn() }));
import Fastify from "fastify";
import { registerTariffVersionRoutes } from "../../src/modules/pricing-core/transport/tariff-version.routes";
import { proposeTariffVersion, decideTariffVersion, readTariffVersion } from "../../src/modules/pricing-core/repo/tariff-versions";
const planId = "019b0000-0000-7000-8100-000000000001", versionId = "019b0000-0000-7000-8100-000000000002", operationId = "019b0000-0000-7000-8100-000000000003";
const mockActor = { id: "verified-user", tenantId: "verified-tenant", companyMembershipId: "verified-membership" };
let mockAuthenticated = true, mockPermissions: string[] = [];
const app = Fastify(); registerTariffVersionRoutes(app);
beforeEach(() => { jest.clearAllMocks(); mockAuthenticated = true; mockPermissions = []; });
afterAll(() => app.close());
it("proposal forwards verified context and normalized bounded request", async () => {
  jest.mocked(proposeTariffVersion).mockResolvedValue({ id: versionId } as any);
  const response = await app.inject({ method: "POST", url: `/tariff-plans/${planId}/versions`, payload: { operationId, expectedGeneration: 2, reason: "  Reviewed synthetic configuration  " } });
  expect(response.statusCode).toBe(201); expect(mockPermissions).toEqual(["pricing.tariffs.propose"]);
  expect(proposeTariffVersion).toHaveBeenCalledWith({ user: mockActor, planId, operationId, expectedGeneration: 2, reason: "Reviewed synthetic configuration" });
});
it("decision binds the displayed content digest without accepting ownership or prices", async () => {
  jest.mocked(decideTariffVersion).mockResolvedValue({ decision: "approved" } as any);
  const payload = { operationId, contentSha256: "a".repeat(64), decision: "approved", reason: "Synthetic independent review" };
  expect((await app.inject({ method: "POST", url: `/tariff-plans/${planId}/versions/${versionId}/decision`, payload })).statusCode).toBe(201);
  expect(mockPermissions).toEqual(["pricing.tariffs.approve"]);
  expect(decideTariffVersion).toHaveBeenCalledWith({ user: mockActor, planId, versionId, ...payload });
});
it.each([{ tenantId: planId }, { amount: "1.00" }, { companyId: planId }, { approved: true }])("unknown request fields are rejected before service calls", async extra => {
  const result = await app.inject({ method: "POST", url: `/tariff-plans/${planId}/versions`, payload: { operationId, expectedGeneration: 0, reason: "Synthetic", ...extra } });
  expect(result.statusCode).toBe(400); expect(proposeTariffVersion).not.toHaveBeenCalled();
});
it("anonymous access has no service effects", async () => {
  mockAuthenticated = false;
  expect((await app.inject({ method: "GET", url: `/tariff-plans/${planId}/versions/${versionId}` })).statusCode).toBe(401);
  expect(readTariffVersion).not.toHaveBeenCalled();
});
it("unexpected database diagnostics are not exposed", async () => {
  jest.mocked(readTariffVersion).mockRejectedValue(Error("SYNTHETIC_PRIVATE_DIAGNOSTIC"));
  const response = await app.inject({ method: "GET", url: `/tariff-plans/${planId}/versions/${versionId}` });
  expect(response.statusCode).toBe(500); expect(response.body).not.toContain("SYNTHETIC_PRIVATE_DIAGNOSTIC");
});
