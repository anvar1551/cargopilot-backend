jest.mock("../../src/modules/identity-access/transport/fastify-auth", () => ({ fastifyAuth: () => async () => undefined }));
jest.mock("../../src/modules/payments-core/application/paymentsService", () => ({
  listProviderConfigsForActor: jest.fn(), upsertCompanyPaymentPolicyForActor: jest.fn(), testProviderConfigForActor: jest.fn(),
}));
import Fastify from "fastify";
import routes from "../../src/modules/payments-core/transport/fastify-routes";
import { listProviderConfigsForActor, upsertCompanyPaymentPolicyForActor, testProviderConfigForActor } from "../../src/modules/payments-core/application/paymentsService";
beforeEach(() => jest.clearAllMocks());
it.each([400, 403, 404, 500])("settings exception %s cannot expose credentials or internal database details", async statusCode => {
  const app = Fastify();
  try {
    await app.register(routes);
    jest.mocked(listProviderConfigsForActor).mockRejectedValue(Object.assign(Error("SYNTHETIC-SECRET-CANARY"), { statusCode }));
    const response = await app.inject({ method: "GET", url: "/settings/payments/providers" });
    expect(response.statusCode).toBe(statusCode); expect(response.body).not.toContain("SYNTHETIC-SECRET-CANARY");
  } finally { await app.close(); }
});
it("policy write returns an explicit approval-containment contract", async () => {
  const app = Fastify();
  try {
    await app.register(routes);
    jest.mocked(upsertCompanyPaymentPolicyForActor).mockRejectedValue(Object.assign(Error("PRIVATE-CANARY"), { statusCode: 409, code: "PAYMENT_CONFIGURATION_APPROVAL_REQUIRED" }));
    const response = await app.inject({ method: "PUT", url: "/settings/payments/policy", payload: {
      companyId: "10000000-0000-4000-8000-000000000001", onlinePaymentsEnabled: true,
    } });
    expect(response.statusCode).toBe(409); expect(response.json().code).toBe("PAYMENT_CONFIGURATION_APPROVAL_REQUIRED");
    expect(response.body).not.toContain("PRIVATE-CANARY");
  } finally { await app.close(); }
});
it("local credential-test errors are sanitized through the HTTP boundary", async () => {
  const app = Fastify();
  try {
    await app.register(routes);
    jest.mocked(testProviderConfigForActor).mockRejectedValue(Error("PRIVATE-CANARY"));
    const response = await app.inject({ method: "POST", url: "/settings/payments/providers/10000000-0000-4000-8000-000000000001/test" });
    expect(response.statusCode).toBe(500); expect(response.body).not.toContain("PRIVATE-CANARY");
  } finally { await app.close(); }
});
