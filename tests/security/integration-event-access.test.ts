jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
import { database as db } from "./fixtures";
import { listIntegrationWebhookEventsForActor as webhooks, listIntegrationCanonicalEventsForActor as events } from "../../src/modules/integrations-core/application/integration-admin.service";
const actor = (companyId = "ca", tenantId = "ta", membership = "ma"): any => ({ id: "same-user", companyId, tenantId,
  companyMembershipId: membership, membershipId: membership, tenantMembershipId: "tm-" + tenantId, permissions: ["policy.override"] });
const a = actor(), b = actor("cb", "tb", "mb"), c = actor("cc", "ta", "mc");
const p = { id: "pa", domain: "carrier", providerCode: "sandbox", environment: "sandbox" }, now = new Date();
const row = { id: "event", companyId: "ca", providerId: "pa", providerCode: "sandbox", domain: "carrier", environment: "sandbox",
  signatureVerified: true, rawBodySha256: "a".repeat(64), receivedAt: now, processedAt: now, occurredAt: now, createdAt: now,
  updatedAt: now, lockedAt: null, processAttempts: 1, source: "inbound_webhook", status: "processed", webhookEventId: "webhook", outboxId: null,
  provider: { ...p, status: "active", secretRef: "SENSITIVE-CANARY" }, rawBody: "SENSITIVE-CANARY", headersJson: "SENSITIVE-CANARY",
  providerEventId: "SENSITIVE-CANARY", payloadJson: "SENSITIVE-CANARY", aggregateId: "SENSITIVE-CANARY", eventType: "SENSITIVE-CANARY",
  ipAddress: "SENSITIVE-CANARY", lastError: "SENSITIVE-CANARY", canonicalEvent: "SENSITIVE-CANARY", canonicalEvents: ["SENSITIVE-CANARY"] };
beforeEach(() => {
  jest.clearAllMocks(); db.companyMembership.findFirst.mockReset().mockImplementation(async ({ where }: any) => ({ companyId: where.companyId, tenantId: where.tenantId,
    scopes: [{ scopeType: "company", scopeRefId: where.companyId }], roles: [{ role: { companyId: where.companyId, isSystem: false,
      rolePermissions: [{ permission: { key: "integration.outbox.read" } }] } }] }));
  db.integrationProvider.findMany.mockReset().mockResolvedValue([p]);
  for (const model of ["integrationWebhookEvent", "integrationCanonicalEvent"]) {
    db[model].findMany.mockReset().mockResolvedValue([row]); db[model].count.mockReset().mockResolvedValue(1);
  }
  db.$transaction.mockReset().mockImplementation((queries: any) => Promise.all(queries));
});
afterEach(() => {
  expect(db.companyMembership.findMany).not.toHaveBeenCalled();
  for (const model of ["integrationOutbox", "integrationWebhookEvent", "integrationCanonicalEvent", "order"])
    for (const method of ["create", "update", "updateMany", "upsert", "delete"]) expect(db[model][method]).not.toHaveBeenCalled();
});
it.each([a, b, c])("selected tenant/company and current provider tuple scope both event lists and counts", async user => {
  await webhooks({ user }); await events({ user });
  for (const model of ["integrationWebhookEvent", "integrationCanonicalEvent"]) {
    const query = db[model].findMany.mock.calls[0][0]; expect(query.where.companyId).toBe(user.companyId);
    expect(db[model].count.mock.calls[0][0].where).toEqual(query.where);
    expect(query.where.OR[0]).toMatchObject({ providerId: "pa", domain: "carrier", providerCode: "sandbox", provider: { is: {
      companyId: user.companyId, company: { is: { tenantId: user.tenantId, isActive: true, tenant: { is: { status: "active" } } } }, environment: "sandbox" } } });
  }
});
it("canonical source alternatives require matching authenticated webhook or owned outbox, never both", async () => {
  await events({ user: a }); const branches = db.integrationCanonicalEvent.findMany.mock.calls[0][0].where.OR[0].OR;
  expect(branches[0]).toMatchObject({ source: "inbound_webhook", outboxId: null, webhookEvent: { is: { signatureVerified: true, companyId: "ca", providerId: "pa", domain: "carrier", providerCode: "sandbox", environment: "sandbox" } } });
  expect(branches[1]).toMatchObject({ source: "outbound_response", webhookEventId: null, outbox: { is: { companyId: "ca", providerId: "pa", domain: "carrier", providerCode: "sandbox", environment: "sandbox" } } });
  expect(branches[1].outbox.is.AND[0].OR[1]).toMatchObject({ ownershipTenantId: "ta", ownedOrder: { is: { tenantId: "ta", ownerOrgId: "ca" } } });
});
it("metadata projections never query or return raw content or nested business events", async () => {
  const results = [await webhooks({ user: a }), await events({ user: a })] as const; expect(JSON.stringify(results)).not.toContain("SENSITIVE-CANARY");
  expect(results[0].items[0].rawBodySha256).toHaveLength(64); expect(results[1].items[0].status).toBe("processed");
  for (const model of ["integrationWebhookEvent", "integrationCanonicalEvent"]) for (const key of ["rawBody", "headersJson", "payloadJson", "lastError", "aggregateId", "canonicalEvent", "canonicalEvents"])
    expect(db[model].findMany.mock.calls[0][0].select).not.toHaveProperty(key);
});
it("digest is only returned when it is a bounded SHA256 value", async () => {
  db.integrationWebhookEvent.findMany.mockResolvedValue([{ ...row, rawBodySha256: "SENSITIVE-CANARY" }]);
  expect((await webhooks({ user: a })).items[0].rawBodySha256).toBeNull();
});
it("filters retain ownership; search cannot inspect provider event or business payload text", async () => {
  await webhooks({ user: a, domain: "carrier", providerCode: "SANDBOX", q: "sandbox", page: 2, limit: 3 });
  await events({ user: a, status: "failed", q: "sandbox" });
  expect(db.integrationWebhookEvent.findMany.mock.calls[0][0]).toMatchObject({ skip: 3, take: 3, where: { providerCode: { contains: "sandbox", mode: "insensitive" } } });
  expect(db.integrationCanonicalEvent.findMany.mock.calls[0][0].where.status).toBe("failed");
});
it.each([null, { ...a, tenantId: null }, { ...a, membershipId: "other" }])("missing context denies before event reads", async user => {
  for (const read of [webhooks, events]) await expect(read({ user })).rejects.toMatchObject({ statusCode: 403 });
  expect(db.integrationProvider.findMany).not.toHaveBeenCalled();
});
it.each(["revoked", "permission", "scope"])("fresh %s denies despite stale override claims", async kind => {
  const membership = await db.companyMembership.findFirst({ where: a }); db.companyMembership.findFirst.mockResolvedValue(kind === "revoked" ? null : {
    ...membership, ...(kind === "permission" ? { roles: [] } : { scopes: [] }) });
  for (const read of [webhooks, events]) await expect(read({ user: a })).rejects.toMatchObject({ statusCode: 403 });
  expect(db.integrationProvider.findMany).not.toHaveBeenCalled();
});
it("foreign selected company request is rejected before any event query", async () => {
  for (const read of [webhooks, events]) await expect(read({ user: a, companyId: b.companyId })).rejects.toMatchObject({ statusCode: 403 });
  expect(db.integrationProvider.findMany).not.toHaveBeenCalled();
});
it.each([{ limit: 101 }, { page: 0 }, { q: "x".repeat(181) }, { providerCode: "../" }])("invalid search/pagination denies", async input => {
  for (const read of [webhooks, events]) await expect(read({ user: a, ...input })).rejects.toMatchObject({ statusCode: 400 });
});
it("empty configurations remain false for rows and counts; excess configurations reject", async () => {
  db.integrationProvider.findMany.mockResolvedValue([]); await webhooks({ user: a }); await events({ user: a });
  for (const model of ["integrationWebhookEvent", "integrationCanonicalEvent"]) expect(db[model].findMany.mock.calls[0][0].where.OR).toEqual([]);
  db.integrationProvider.findMany.mockResolvedValue(Array(101).fill(p));
  for (const read of [webhooks, events]) await expect(read({ user: a })).rejects.toMatchObject({ code: "INTEGRATION_READ_CAPACITY" });
});
