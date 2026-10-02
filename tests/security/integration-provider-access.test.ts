jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
import { database } from "./fixtures";
import { listIntegrationProvidersForActor as list } from "../../src/modules/integrations-core/application/provider-access";
const actor = (companyId = "ca", tenantId = "ta", membership = "ma"): any => ({ id: "same-user", companyId, tenantId,
  tenantMembershipId: "tm-" + tenantId, companyMembershipId: membership, membershipId: membership,
  permissions: ["policy.override", "integration.provider.read"] });
const a = actor(), b = actor("cb", "tb", "mb"), sameTenant = actor("cc", "ta", "mc");
const row: any = { id: "provider-a", companyId: "ca", domain: "carrier", providerCode: "sandbox", status: "active", environment: "sandbox",
  capabilities: ["booking"], rateLimitRps: 2, timeoutMs: 5000, retryPolicyId: null, createdAt: new Date(), updatedAt: new Date(),
  secretRef: "SENSITIVE-CANARY", secrets: [{ encryptedSecretJson: "SENSITIVE-CANARY" }], internalCredentials: "SENSITIVE-CANARY" };
beforeEach(() => {
  jest.clearAllMocks();
  database.companyMembership.findFirst.mockReset().mockImplementation(async ({ where }: any) => ({ companyId: where.companyId, tenantId: where.tenantId,
    scopes: [{ scopeType: "company", scopeRefId: where.companyId }], roles: [{ role: { companyId: where.companyId, isSystem: false,
      rolePermissions: [{ permission: { key: "integration.provider.read" } }] } }] }));
  database.integrationProvider.findMany.mockReset().mockResolvedValue([row]);
  database.integrationProvider.findFirst.mockReset().mockResolvedValue({ id: row.id });
  database.integrationProvider.count.mockReset().mockResolvedValue(1);
});
afterEach(() => {
  expect(database.companyMembership.findMany).not.toHaveBeenCalled(); expect(database.$transaction).not.toHaveBeenCalled();
  for (const model of ["integrationProvider", "integrationProviderSecret", "integrationOutbox", "integrationWebhookEvent", "integrationCanonicalEvent"])
    for (const method of ["create", "upsert", "update", "updateMany", "delete"]) expect(database[model][method]).not.toHaveBeenCalled();
});
function scoped(where: any, user: any) { expect(where).toMatchObject({ companyId: user.companyId, company: { is: {
  id: user.companyId, tenantId: user.tenantId, type: "company", isActive: true, tenant: { is: { status: "active" } },
} } }); }
it.each([a, b, sameTenant])("only selected context is queried despite override claims and other memberships", async user => {
  await list({ user, limit: 2 });
  scoped(database.integrationProvider.findMany.mock.calls[0][0].where, user);
  scoped(database.integrationProvider.count.mock.calls[0][0].where, user);
  expect(database.companyMembership.findFirst.mock.calls[0][0].where).toMatchObject({ id: user.companyMembershipId,
    companyId: user.companyId, tenantId: user.tenantId, tenantMembershipId: user.tenantMembershipId, userId: user.id, status: "active" });
});
it("default array is bounded and safe projection excludes credential references and surplus adapter fields", async () => {
  const result = await list({ user: a }); expect(Array.isArray(result)).toBe(true); expect(JSON.stringify(result)).not.toContain("SENSITIVE-CANARY");
  expect(database.integrationProvider.findMany.mock.calls[0][0]).toMatchObject({ take: 100 });
  const select = database.integrationProvider.findMany.mock.calls[0][0].select;
  expect(select).not.toHaveProperty("secretRef"); expect(select).not.toHaveProperty("secrets"); expect(database.integrationProvider.count).not.toHaveBeenCalled();
});
it("filters and cursor validation preserve selected scope and deterministic order", async () => {
  const result: any = await list({ user: a, companyId: a.companyId, limit: 1, cursor: row.id, q: " sandbox ", providerCode: "SANDBOX", domain: "carrier", environment: "sandbox", status: "active" });
  const find = database.integrationProvider.findMany.mock.calls[0][0]; scoped(find.where, a);
  scoped(database.integrationProvider.findFirst.mock.calls[0][0].where.AND[0], a);
  expect(find).toMatchObject({ take: 2, cursor: { id: row.id }, skip: 1, where: { providerCode: "sandbox", domain: "carrier" } });
  expect(find.orderBy).toEqual([{ domain: "asc" }, { providerCode: "asc" }, { environment: "asc" }, { id: "asc" }]);
  expect(database.integrationProvider.count.mock.calls[0][0].where).toEqual(find.where); expect(result.total).toBe(1);
});
it("foreign company equality assertion cannot choose an unselected company", async () => {
  await expect(list({ user: a, companyId: b.companyId })).rejects.toMatchObject({ statusCode: 403 });
  expect(database.integrationProvider.findMany).not.toHaveBeenCalled();
});
it.each([null, { ...a, tenantId: null }, { ...a, tenantMembershipId: null }, { ...a, membershipId: "other" }])("missing bound context rejects before configuration reads", async user => {
  await expect(list({ user })).rejects.toMatchObject({ statusCode: 403 }); expect(database.integrationProvider.findMany).not.toHaveBeenCalled();
});
it.each(["revoked", "permission", "scope", "foreign-scope"])("fresh %s state defeats stale token override", async kind => {
  const membership = await database.companyMembership.findFirst({ where: a });
  database.companyMembership.findFirst.mockResolvedValue(kind === "revoked" ? null : { ...membership,
    ...(kind === "permission" ? { roles: [] } : {}), ...(kind === "scope" ? { scopes: [] } : kind === "foreign-scope" ? { scopes: [{ scopeType: "company", scopeRefId: b.companyId }] } : {}),
  });
  await expect(list({ user: a })).rejects.toMatchObject({ statusCode: 403 }); expect(database.integrationProvider.findMany).not.toHaveBeenCalled();
});
it("foreign/null/unowned/filtered-out cursor reveals no page or count", async () => {
  database.integrationProvider.findFirst.mockResolvedValue(null);
  await expect(list({ user: a, limit: 2, cursor: "foreign" })).rejects.toMatchObject({ statusCode: 404 });
  expect(database.integrationProvider.findMany).not.toHaveBeenCalled(); expect(database.integrationProvider.count).not.toHaveBeenCalled();
});
it.each([{ limit: 0 }, { limit: NaN }, { limit: 101 }, { limit: 1.5 }, { cursor: "id" }, { cursor: "", limit: 1 }, { q: "x".repeat(181) }, { providerCode: "../../invalid" }])("invalid bounded input does not read protected configuration", async input => {
  await expect(list({ user: a, ...input })).rejects.toMatchObject({ statusCode: 400 }); expect(database.integrationProvider.findMany).not.toHaveBeenCalled();
});
it("paginated next cursor uses only returned scoped rows", async () => {
  database.integrationProvider.findMany.mockResolvedValue([row, { ...row, id: "provider-second" }]);
  const result: any = await list({ user: a, limit: 1 }); expect(result.data).toHaveLength(1);
  expect(result.pageInfo).toEqual({ limit: 1, hasNextPage: true, nextCursor: row.id });
});
