jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
import { database as db } from "./fixtures";
import { webhookEventRepository as repo } from "../../src/modules/integrations-core/infrastructure/webhook-events.repo";
import { createWebhookGatewayService } from "../../src/modules/integrations-core/application/webhook-gateway.service";
import { Prisma } from "@prisma/client";
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
function gateway(events: any, enqueue: any = jest.fn()) {
  return createWebhookGatewayService({ events, canonicalEvents: enqueue ? { enqueue } : undefined, providerVerifiers: {
    resolve: async () => ({ ...identity, verifier: { verifyAndNormalize: async () => ({ ok: true, data: canonical }) } } as any) } });
}
it.each([true, false])("racing unique raw insert requires complete persistence (complete=%s)", async complete => {
  const unique = new Prisma.PrismaClientKnownRequestError("synthetic", { code: "P2002", clientVersion: "7.2.0" });
  const events = { hasProcessed: jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(complete), saveRawEvent: jest.fn().mockRejectedValue(unique), saveCanonicalEvent: jest.fn() };
  const service = gateway(events), result = service.ingest({ providerCode: "sandbox", rawBody, headers: {} });
  if (complete) await expect(result).resolves.toMatchObject({ status: "duplicate" });
  else await expect(result).rejects.toMatchObject({ statusCode: 503, code: "WEBHOOK_INGRESS_INCOMPLETE" });
  expect(events.hasProcessed).toHaveBeenCalledTimes(2); expect(events.hasProcessed).toHaveBeenCalledWith(identity); expect(events.saveCanonicalEvent).not.toHaveBeenCalled();
});
it("missing pending persistence cannot accept valid verified ingress", async () => {
  const events = { hasProcessed: jest.fn(), saveRawEvent: jest.fn(), saveCanonicalEvent: jest.fn() };
  await expect(gateway(events, null).ingest({ providerCode: "sandbox", rawBody, headers: {} })).rejects.toMatchObject({ statusCode: 503 });
  expect(events.hasProcessed).not.toHaveBeenCalled(); expect(events.saveRawEvent).not.toHaveBeenCalled();
});
