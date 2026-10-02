jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
import { database as db } from "./fixtures";
import { webhookEventRepository as repo } from "../../src/modules/integrations-core/infrastructure/webhook-events.repo";
import { createWebhookGatewayService } from "../../src/modules/integrations-core/application/webhook-gateway.service";
import { readVerifiedWebhookIngress } from "../../src/modules/integrations-core/application/webhook-gateway.service";
import { createHash } from "crypto";
const rawBody = '{"eventId":"synthetic"}', hash = createHash("sha256").update(rawBody).digest("hex");
const identity: any = { providerId: "pa", providerEventId: "synthetic", companyId: "ca", domain: "carrier", providerCode: "sandbox", environment: "sandbox", rawBodySha256: hash };
const provider = { companyId: "ca", domain: "carrier", providerCode: "sandbox", environment: "sandbox", status: "active",
  company: { isActive: true, type: "company", tenantId: "ta", tenant: { id: "ta", status: "active" } } };
const row = { id: "raw", ...identity, signatureVerified: true, provider, canonicalEvent: { companyId: "ca", domain: "carrier", providerCode: "sandbox" }, canonicalEvents: [{ id: "pending" }] };
beforeEach(() => { jest.clearAllMocks(); db.integrationWebhookEvent.findFirst.mockReset().mockResolvedValue(row); });
afterEach(() => {
  for (const model of ["integrationWebhookEvent", "integrationWebhookCanonicalEvent", "integrationCanonicalEvent", "integrationOutbox"])
    for (const method of ["create", "update", "delete", "upsert"]) expect(db[model][method]).not.toHaveBeenCalled();
});
it("complete current source returns durable acceptance, never a claim of processing success", async () => {
  await expect(repo.hasProcessed(identity)).resolves.toBe(true);
  const query = db.integrationWebhookEvent.findFirst.mock.calls[0][0]; expect(query.select).not.toHaveProperty("rawBody");
  expect(query.select.canonicalEvents.where).toMatchObject({ companyId: "ca", providerId: "pa", source: "inbound_webhook", outboxId: null });
});
it("absent raw source is not a duplicate", async () => { db.integrationWebhookEvent.findFirst.mockResolvedValue(null); await expect(repo.hasProcessed(identity)).resolves.toBe(false); });
it.each([{ canonicalEvent: null }, { canonicalEvents: [] }])("partial persistence is retryable and cannot acknowledge a duplicate", async change => {
  db.integrationWebhookEvent.findFirst.mockResolvedValue({ ...row, ...change });
  await expect(repo.hasProcessed(identity)).rejects.toMatchObject({ statusCode: 503, code: "WEBHOOK_INGRESS_INCOMPLETE" });
});
it.each([{ companyId: "cb" }, { providerCode: "wrong" }, { environment: "production" }, { rawBodySha256: "b".repeat(64) },
  { signatureVerified: false }, { canonicalEvent: { ...row.canonicalEvent, companyId: "cb" } }])("signed ID reuse with incompatible durable identity fails", async change => {
  db.integrationWebhookEvent.findFirst.mockResolvedValue({ ...row, ...change }); await expect(repo.hasProcessed(identity)).rejects.toMatchObject({ statusCode: 409 });
});
it.each([{ provider: null }, { provider: { ...provider, status: "disabled" } }, { provider: { ...provider, company: { ...provider.company, tenant: { id: "ta", status: "suspended" } } } }])("inactive current ownership is not accepted", async change => {
  db.integrationWebhookEvent.findFirst.mockResolvedValue({ ...row, ...change }); await expect(repo.hasProcessed(identity)).rejects.toMatchObject({ statusCode: 403 });
});
it("missing verified context fails before any lookup", async () => {
  await expect(repo.hasProcessed({ ...identity, companyId: null })).rejects.toMatchObject({ statusCode: 403 }); expect(db.integrationWebhookEvent.findFirst).not.toHaveBeenCalled();
});
const canonical: any = { eventId: "synthetic", providerCode: "sandbox", eventType: "carrier.status.updated", occurredAt: new Date().toISOString(), payload: {} };
function gateway(events: any) {
  return createWebhookGatewayService({ events, providerVerifiers: {
    resolve: async () => ({ ...identity, verifier: { verifyAndNormalize: async () => ({ ok: true, data: canonical }) } } as any) } });
}
it.each(["accepted", "duplicate"])("gateway delegates complete persistence with unforgeable evidence (%s)", async status => {
  const events = { persistVerified: jest.fn(async evidence => {
    const data = readVerifiedWebhookIngress(evidence);
    expect(data.provider).toMatchObject({ companyId: "ca", domain: "carrier" });
    expect(data.rawBody).toBe(rawBody); expect(Object.keys(evidence)).toEqual([]);
    return status;
  }) };
  await expect(gateway(events).ingest({ providerCode: "sandbox", rawBody, headers: {} })).resolves.toMatchObject({ status });
  expect(events.persistVerified).toHaveBeenCalledTimes(1);
});
it("forged verification fields or copied evidence fail before database work", async () => {
  await expect(repo.persistVerified({ ...identity, signatureVerified: true } as any)).rejects.toMatchObject({ statusCode: 403 });
  expect(db.$transaction).not.toHaveBeenCalled();
});
