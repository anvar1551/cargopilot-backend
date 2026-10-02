jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
import { database as db } from "./fixtures";
import { listIntegrationOutboxForActor as list, listIntegrationOutboxAttemptsForActor as attempts } from "../../src/modules/integrations-core/application/integration-admin.service";
const actor = (companyId = "ca", tenantId = "ta", membership = "ma"): any => ({ id: "same-user", companyId, tenantId,
  companyMembershipId: membership, membershipId: membership, tenantMembershipId: "tm-" + tenantId, permissions: ["policy.override"] });
const a = actor(), b = actor("cb", "tb", "mb"), c = actor("cc", "ta", "mc");
const provider = { id: "pa", domain: "carrier", providerCode: "sandbox", environment: "sandbox" };
const now = new Date();
const delivery = { id: "attempt", outboxId: "outbox", attemptNo: 1, outcome: "success", statusCode: 200, retryable: false,
  startedAt: now, finishedAt: now, createdAt: now, errorMessage: "SENSITIVE-CANARY", requestJson: "SENSITIVE-CANARY", responseJson: "SENSITIVE-CANARY", providerRequestId: "SENSITIVE-CANARY" };
const row = { id: "outbox", companyId: "ca", providerId: "pa", providerCode: "sandbox", domain: "carrier", environment: "sandbox",
  status: "sent", maxAttempts: 5, attemptCount: 1, nextAttemptAt: now, lastAttemptAt: now, createdAt: now, updatedAt: now,
  provider: { ...provider, status: "active", secretRef: "SENSITIVE-CANARY" }, attempts: [delivery], payload: "SENSITIVE-CANARY",
  lastError: "SENSITIVE-CANARY", idempotencyKey: "SENSITIVE-CANARY", aggregateId: "SENSITIVE-CANARY", eventType: "SENSITIVE-CANARY" };
beforeEach(() => {
  jest.clearAllMocks();
  db.companyMembership.findFirst.mockReset().mockImplementation(async ({ where }: any) => ({ companyId: where.companyId, tenantId: where.tenantId,
    scopes: [{ scopeType: "company", scopeRefId: where.companyId }], roles: [{ role: { companyId: where.companyId, isSystem: false,
      rolePermissions: [{ permission: { key: "integration.outbox.read" } }] } }] }));
  db.integrationProvider.findMany.mockReset().mockResolvedValue([provider]);
  db.integrationOutbox.findMany.mockReset().mockResolvedValue([row]);
  db.integrationOutbox.count.mockReset().mockResolvedValue(1);
  db.integrationOutbox.findFirst.mockReset().mockResolvedValue({ id: row.id });
  db.integrationDeliveryAttempt.findMany.mockReset().mockResolvedValue([delivery]);
  db.$transaction.mockReset().mockImplementation((queries: any) => Promise.all(queries));
});
afterEach(() => {
  expect(db.companyMembership.findMany).not.toHaveBeenCalled(); expect(db.integrationOutbox.findUnique).not.toHaveBeenCalled();
  for (const model of ["integrationOutbox", "integrationDeliveryAttempt", "integrationProvider", "order"])
    for (const method of ["create", "update", "updateMany", "upsert", "delete"]) expect(db[model][method]).not.toHaveBeenCalled();
});
function scoped(where: any, user: any) {
  expect(where).toMatchObject({ companyId: user.companyId, company: { is: { id: user.companyId,
    tenantId: user.tenantId, isActive: true, type: "company", tenant: { is: { status: "active" } } } } });
  expect(where.AND[0].OR).toEqual([expect.objectContaining({ providerId: "pa", domain: "carrier", providerCode: "sandbox", environment: "sandbox",
    provider: { is: expect.objectContaining({ companyId: user.companyId, id: "pa", domain: "carrier", providerCode: "sandbox", environment: "sandbox" }) } })]);
  expect(where.AND[1].OR).toEqual([{ ownershipTenantId: null, ownershipOrderId: null }, {
    ownershipTenantId: user.tenantId, ownershipOrderId: { not: null }, ownedOrder: { is: { tenantId: user.tenantId, ownerOrgId: user.companyId } },
  }]);
}
it.each([a, b, c])("list/count and attempts use only the freshly selected context", async user => {
  await list({ user }); await attempts({ user, outboxId: row.id });
  const find = db.integrationOutbox.findMany.mock.calls[0][0]; scoped(find.where, user);
  expect(db.integrationOutbox.count.mock.calls[0][0].where).toEqual(find.where);
  const parent = db.integrationOutbox.findFirst.mock.calls[0][0]; scoped(parent.where, user); expect(parent.select).toEqual({ id: true });
  scoped(db.integrationDeliveryAttempt.findMany.mock.calls[0][0].where.outbox.is, user);
  expect(db.companyMembership.findFirst.mock.calls[0][0].where).toMatchObject({ userId: user.id, id: user.membershipId, tenantId: user.tenantId });
});
it("projects metadata only, including nested attempts and providers", async () => {
  const result = await list({ user: a }); const details = await attempts({ user: a, outboxId: row.id });
  expect(result.total).toBe(1); expect(result.items[0].status).toBe("sent"); expect(details[0].outcome).toBe("success");
  expect(JSON.stringify([result, details])).not.toContain("SENSITIVE-CANARY");
  const select = db.integrationOutbox.findMany.mock.calls[0][0].select;
  for (const key of ["payload", "lastError", "aggregateId", "idempotencyKey"]) expect(select).not.toHaveProperty(key);
  for (const key of ["requestJson", "responseJson", "errorMessage", "providerRequestId"])
    expect(db.integrationDeliveryAttempt.findMany.mock.calls[0][0].select).not.toHaveProperty(key);
});
it("filters, counts and stable pagination share ownership predicates", async () => {
  await list({ user: a, companyId: a.companyId, providerCode: "SANDBOX", domain: "carrier", status: "failed", page: 2, limit: 3 });
  expect(db.integrationProvider.findMany.mock.calls[0][0]).toMatchObject({ where: { companyId: "ca", providerCode: "sandbox", domain: "carrier" }, take: 101 });
  expect(db.integrationOutbox.findMany.mock.calls[0][0]).toMatchObject({ where: { status: "failed" }, skip: 3, take: 3,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }] });
});
it("empty provider set is false for both lists and counts", async () => {
  db.integrationProvider.findMany.mockResolvedValue([]); db.integrationOutbox.findMany.mockResolvedValue([]); db.integrationOutbox.count.mockResolvedValue(0);
  expect((await list({ user: a })).total).toBe(0); expect(db.integrationOutbox.findMany.mock.calls[0][0].where.AND[0]).toEqual({ OR: [] });
});
it("bounded provider tuple expansion fails rather than truncates counts or broadens ownership", async () => {
  db.integrationProvider.findMany.mockResolvedValue(Array(101).fill(provider));
  await expect(list({ user: a })).rejects.toMatchObject({ statusCode: 409, code: "INTEGRATION_READ_CAPACITY" });
  expect(db.integrationOutbox.findMany).not.toHaveBeenCalled(); expect(db.integrationOutbox.count).not.toHaveBeenCalled();
});
it.each([null, { ...a, tenantId: null }, { ...a, tenantMembershipId: null }, { ...a, membershipId: "other" }])("missing context denies before protected reads", async user => {
  await expect(list({ user })).rejects.toMatchObject({ statusCode: 403 }); await expect(attempts({ user, outboxId: "outbox" })).rejects.toMatchObject({ statusCode: 403 });
  expect(db.integrationProvider.findMany).not.toHaveBeenCalled(); expect(db.integrationOutbox.findMany).not.toHaveBeenCalled();
});
it.each(["revoked", "permission", "scope"])("fresh %s state defeats stale claims", async kind => {
  const membership = await db.companyMembership.findFirst({ where: a }); db.companyMembership.findFirst.mockResolvedValue(kind === "revoked" ? null : {
    ...membership, ...(kind === "permission" ? { roles: [] } : { scopes: [] }) });
  await expect(list({ user: a })).rejects.toMatchObject({ statusCode: 403 }); expect(db.integrationProvider.findMany).not.toHaveBeenCalled();
});
it("foreign company cannot be selected by a query filter", async () => {
  await expect(list({ user: a, companyId: b.companyId })).rejects.toMatchObject({ statusCode: 403 }); expect(db.integrationProvider.findMany).not.toHaveBeenCalled();
});
it("foreign/null/conflicting parent denies without fetching attempt content", async () => {
  db.integrationOutbox.findFirst.mockResolvedValue(null);
  await expect(attempts({ user: a, outboxId: "foreign" })).rejects.toMatchObject({ statusCode: 404 }); expect(db.integrationDeliveryAttempt.findMany).not.toHaveBeenCalled();
});
it.each([{ page: NaN }, { page: 10001 }, { limit: 101 }, { limit: 1.5 }, { providerCode: "../x" }, { domain: "wrong" }, { status: "wrong" }])("invalid input cannot broaden a query", async input => {
  await expect(list({ user: a, ...input as any })).rejects.toMatchObject({ statusCode: 400 }); expect(db.integrationOutbox.findMany).not.toHaveBeenCalled();
});
it("missing parent id and unbounded attempts reject before lookup", async () => {
  await expect(attempts({ user: a, outboxId: "" })).rejects.toMatchObject({ statusCode: 400 });
  await expect(attempts({ user: a, outboxId: "outbox", limit: 201 })).rejects.toMatchObject({ statusCode: 400 }); expect(db.integrationOutbox.findFirst).not.toHaveBeenCalled();
});
