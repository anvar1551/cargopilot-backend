import { replayIntegrationOutboxForActor, retryIntegrationOutboxNowForActor } from "../../src/modules/integrations-core/application/integration-admin.service";
jest.mock("../../src/modules/identity-access/transport/fastify-auth", () => ({ fastifyAuth: () => async () => undefined }));
jest.mock("../../src/modules/integrations-core/application/integration-admin.service", () => ({ listIntegrationWebhookEventsForActor: jest.fn(), listIntegrationCanonicalEventsForActor: jest.fn(), listIntegrationOutboxForActor: jest.fn(), listIntegrationOutboxAttemptsForActor: jest.fn(), listIntegrationProvidersForActor: jest.fn(), replayIntegrationOutboxForActor: jest.fn(), retryIntegrationOutboxNowForActor: jest.fn(), upsertIntegrationProviderForActor: jest.fn(), rotateIntegrationProviderSecretForActor: jest.fn(), deleteIntegrationProviderForActor: jest.fn(), updateIntegrationProviderStatusForActor: jest.fn() }));
jest.mock("../../src/modules/integrations-core/application/carrier-routing.service", () => ({}));
jest.mock("../../src/modules/integrations-core/application/route-template.service", () => ({}));
const mockWebhookIngest = jest.fn();
jest.mock("../../src/modules/integrations-core/application/webhook-gateway.service", () => ({ createWebhookGatewayService: () => ({ ingest: mockWebhookIngest }) }));
jest.mock("../../src/modules/integrations-core/infrastructure/provider-webhook-verifier.resolver", () => ({}));
jest.mock("../../src/modules/integrations-core/infrastructure/webhook-events.repo", () => ({}));
jest.mock("../../src/modules/integrations-core/infrastructure/canonical-event.repo", () => ({}));
import Fastify from "fastify";
import routes from "../../src/modules/integrations-core/transport/fastify-routes";
import { listIntegrationProvidersForActor } from "../../src/modules/integrations-core/application/integration-admin.service";
import { listIntegrationWebhookEventsForActor, listIntegrationCanonicalEventsForActor, listIntegrationOutboxForActor, listIntegrationOutboxAttemptsForActor } from "../../src/modules/integrations-core/application/integration-admin.service";
import { upsertIntegrationProviderForActor, rotateIntegrationProviderSecretForActor, deleteIntegrationProviderForActor, updateIntegrationProviderStatusForActor } from "../../src/modules/integrations-core/application/integration-admin.service";
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
it.each([
  ["POST","/providers",upsertIntegrationProviderForActor,"INTEGRATION_CONFIGURATION_WORKFLOW_REQUIRED",{companyId:"10000000-0000-4000-8000-000000000001",domain:"carrier",providerCode:"sandbox",environment:"sandbox"}],
  ["PATCH","/providers/10000000-0000-4000-8000-000000000001/status",updateIntegrationProviderStatusForActor,"INTEGRATION_FINANCE_CONFIGURATION_APPROVAL_REQUIRED",{status:"paused"}],
  ["DELETE","/providers/10000000-0000-4000-8000-000000000001",deleteIntegrationProviderForActor,"INTEGRATION_PROVIDER_HISTORY_REQUIRED",undefined],
  ["POST","/providers/10000000-0000-4000-8000-000000000001/rotate-secret",rotateIntegrationProviderSecretForActor,"INTEGRATION_CONFIGURATION_WORKFLOW_REQUIRED",{secretPayload:"synthetic"}],
] as const)("%s provider mutation returns a safe explicit containment contract",async(method,url,handler,code,payload)=>{
  const app=Fastify();try{
    await app.register(routes);jest.mocked(handler).mockRejectedValue(Object.assign(Error("PRIVATE-CANARY"),{statusCode:409,code}));
    const response=await app.inject({method,url,payload});expect(response.statusCode).toBe(409);expect(response.json().code).toBe(code);expect(response.body).not.toContain("PRIVATE-CANARY");
    expect(handler).toHaveBeenCalledTimes(1);
  }finally{await app.close();}
});
it.each([["replay",replayIntegrationOutboxForActor],["retry-now",retryIntegrationOutboxNowForActor]] as const)("manual %s exposes a safe unavailable contract",async(action,handler)=>{
  const app=Fastify();try{
    await app.register(routes);jest.mocked(handler).mockRejectedValue(Object.assign(Error("PRIVATE-CANARY"),{statusCode:409,code:"INTEGRATION_OUTBOX_RECOVERY_REQUIRED"}));
    const response=await app.inject({method:"POST",url:`/outbox/10000000-0000-4000-8000-000000000001/${action}`});
    expect(response.statusCode).toBe(409);expect(response.json().code).toBe("INTEGRATION_OUTBOX_RECOVERY_REQUIRED");expect(response.body).not.toContain("PRIVATE-CANARY");expect(handler).toHaveBeenCalledTimes(1);
  }finally{await app.close();}
});

it.each([400, 403, 404, 500])("outbox and attempt read errors %s expose no private diagnostics", async statusCode => {
  const app = Fastify(); try {
    await app.register(routes);
    for (const [url, handler] of [["/outbox", listIntegrationOutboxForActor],
      ["/outbox/10000000-0000-4000-8000-000000000001/attempts", listIntegrationOutboxAttemptsForActor]] as const) {
      jest.mocked(handler).mockRejectedValue(Object.assign(Error("PRIVATE-CANARY"), { statusCode }));
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(statusCode); expect(response.body).not.toContain("PRIVATE-CANARY");
    }
  } finally { await app.close(); }
});
it("outbox capacity has a safe narrowing response, not partial totals", async () => {
  const app = Fastify(); try {
    await app.register(routes); jest.mocked(listIntegrationOutboxForActor).mockRejectedValue(Object.assign(Error("PRIVATE-CANARY"), {
      statusCode: 409, code: "INTEGRATION_READ_CAPACITY" }));
    const response = await app.inject({ method: "GET", url: "/outbox" });
    expect(response.statusCode).toBe(409); expect(response.json().code).toBe("INTEGRATION_READ_CAPACITY"); expect(response.body).not.toContain("PRIVATE-CANARY");
  } finally { await app.close(); }
});
it("outbox metadata list and attempt array retain response envelopes", async () => {
  const app = Fastify(); try {
    await app.register(routes); const page = { items: [], total: 0, page: 2, limit: 3 };
    jest.mocked(listIntegrationOutboxForActor).mockResolvedValue(page);
    jest.mocked(listIntegrationOutboxAttemptsForActor).mockResolvedValue([]);
    const response = await app.inject({ method: "GET", url: "/outbox?page=2&limit=3&domain=carrier" });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual(page);
    expect(listIntegrationOutboxForActor).toHaveBeenCalledWith(expect.objectContaining({ page: 2, limit: 3, domain: "carrier" }));
    const details = await app.inject({ method: "GET", url: "/outbox/10000000-0000-4000-8000-000000000001/attempts?limit=2" });
    expect(details.statusCode).toBe(200); expect(details.json()).toEqual([]);
  } finally { await app.close(); }
});

it.each([400, 403, 404, 500])("event read errors %s suppress internal diagnostics", async statusCode => {
  const app = Fastify(); try {
    await app.register(routes);
    for (const [url, handler] of [["/webhook-events", listIntegrationWebhookEventsForActor],
      ["/canonical-events", listIntegrationCanonicalEventsForActor]] as const) {
      jest.mocked(handler).mockRejectedValue(Object.assign(Error("PRIVATE-CANARY"), { statusCode }));
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(statusCode); expect(response.body).not.toContain("PRIVATE-CANARY");
    }
  } finally { await app.close(); }
});
it("event list envelopes and validated transport filters remain supported", async () => {
  const app = Fastify(); try {
    await app.register(routes); const page = { items: [], total: 0, page: 1, limit: 2 };
    jest.mocked(listIntegrationWebhookEventsForActor).mockResolvedValue(page);
    jest.mocked(listIntegrationCanonicalEventsForActor).mockResolvedValue(page);
    for (const url of ["/webhook-events?limit=2&providerCode=sandbox", "/canonical-events?limit=2&status=processed"]) {
      const response = await app.inject({ method: "GET", url }); expect(response.statusCode).toBe(200); expect(response.json()).toEqual(page);
    }
    expect(listIntegrationCanonicalEventsForActor).toHaveBeenCalledWith(expect.objectContaining({ status: "processed", limit: 2 }));
  } finally { await app.close(); }
});
it.each([403, 409, 503, 500])("ingress persistence error %s never exposes diagnostics or acknowledges acceptance", async statusCode => {
  const app = Fastify(); try {
    await app.register(routes); mockWebhookIngest.mockRejectedValue(Object.assign(Error("PRIVATE-CANARY"), { statusCode,
      ...(statusCode === 503 ? { code: "WEBHOOK_INGRESS_INCOMPLETE" } : {}) }));
    const response = await app.inject({ method: "POST", url: "/webhooks/synthetic", payload: '{"eventId":"synthetic"}', headers: { "content-type": "application/json" } });
    expect(response.statusCode).toBe(statusCode); expect(response.json().status).toBe("rejected"); expect(response.body).not.toContain("PRIVATE-CANARY");
    if (statusCode === 503) expect(response.json().code).toBe("WEBHOOK_INGRESS_INCOMPLETE");
  } finally { await app.close(); }
});
