jest.mock("../../src/modules/identity-access/transport/fastify-auth", () => ({ fastifyAuth: () => async () => undefined }));
jest.mock("../../src/modules/integrations-core/application/integration-admin.service", () => ({ listIntegrationProvidersForActor: jest.fn() }));
jest.mock("../../src/modules/integrations-core/application/carrier-routing.service", () => ({}));
jest.mock("../../src/modules/integrations-core/application/route-template.service", () => ({}));
jest.mock("../../src/modules/integrations-core/application/webhook-gateway.service", () => ({ createWebhookGatewayService: () => ({}) }));
jest.mock("../../src/modules/integrations-core/infrastructure/provider-webhook-verifier.resolver", () => ({}));
jest.mock("../../src/modules/integrations-core/infrastructure/webhook-events.repo", () => ({}));
jest.mock("../../src/modules/integrations-core/infrastructure/canonical-event.repo", () => ({}));
import Fastify from "fastify";
import routes from "../../src/modules/integrations-core/transport/fastify-routes";
import { listIntegrationProvidersForActor } from "../../src/modules/integrations-core/application/integration-admin.service";
beforeEach(() => jest.clearAllMocks());
it.each([400, 403, 404, 500])("provider list error %s exposes no database or credential detail", async statusCode => {
  const app = Fastify();
  try {
    await app.register(routes);
    jest.mocked(listIntegrationProvidersForActor).mockRejectedValue(Object.assign(Error("PRIVATE-CANARY"), { statusCode }));
    const response = await app.inject({ method: "GET", url: "/providers" });
    expect(response.statusCode).toBe(statusCode); expect(response.body).not.toContain("PRIVATE-CANARY");
  } finally { await app.close(); }
});
it("valid paginated query retains its transport contract", async () => {
  const app = Fastify();
  try {
    await app.register(routes);
    const expected = { data: [], total: 0, pageInfo: { limit: 2, hasNextPage: false, nextCursor: null } };
    jest.mocked(listIntegrationProvidersForActor).mockResolvedValue(expected);
    const response = await app.inject({ method: "GET", url: "/providers?limit=2&domain=carrier&environment=sandbox" });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual(expected);
    expect(listIntegrationProvidersForActor).toHaveBeenCalledWith(expect.objectContaining({ limit: 2, domain: "carrier", environment: "sandbox" }));
  } finally { await app.close(); }
});
it("invalid pagination rejects before service work", async () => {
  const app = Fastify();
  try {
    await app.register(routes);
    const response = await app.inject({ method: "GET", url: "/providers?limit=101" });
    expect(response.statusCode).toBe(400); expect(listIntegrationProvidersForActor).not.toHaveBeenCalled();
  } finally { await app.close(); }
});
