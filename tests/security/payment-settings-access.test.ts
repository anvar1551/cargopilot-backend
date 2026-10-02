jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
jest.mock("../../src/modules/payments-core/application/paymentCrypto", () => ({ decryptSecret: jest.fn() }));
import { database } from "./fixtures";
import { decryptSecret } from "../../src/modules/payments-core/application/paymentCrypto";
import { getCompanyPaymentPolicyForActor as policy, listProviderConfigsForActor as list,
  listAvailableProvidersForActor as available, upsertCompanyPaymentPolicyForActor as policyWrite,
  upsertProviderConfigForActor as create, patchProviderConfigForActor as patch,
  testProviderConfigForActor as localTest, collectProviderConfigIssues } from "../../src/modules/payments-core/application/payment-settings";

const actor = (companyId = "ca", tenantId = "ta", membership = "ma"): any => ({ id: "same-user",
  companyId, tenantId, tenantMembershipId: "tm-" + tenantId, companyMembershipId: membership, membershipId: membership });
const a = actor(), b = actor("cb", "tb", "mb"), sameTenant = actor("cc", "ta", "mc");
const row: any = { id: "config-a", companyId: "ca", provider: "STRIPE", environment: "TEST", isEnabled: true,
  callbackPath: "/api/payments/stripe/callback", createdAt: new Date(), updatedAt: new Date(),
  serviceId: "whsec_SYNTHETIC_CANARY", merchantId: "SYNTHETIC_CANARY", accountId: "SYNTHETIC_CANARY",
  secretMasked: "SYNTHETIC_CANARY", secretEncrypted: "SYNTHETIC_CANARY" };
const methods = ["payments.providers.read", "payments.providers.manage", "payments.intents.create"];
const oldEnabled = process.env.PAYMENTS_ENABLED;
beforeEach(() => {
  jest.clearAllMocks(); process.env.PAYMENTS_ENABLED = "true";
  database.companyMembership.findFirst.mockReset().mockImplementation(async ({ where }: any) => ({ companyId: where.companyId,
    tenantId: where.tenantId, scopes: [{ scopeType: "company", scopeRefId: where.companyId }],
    roles: [{ role: { companyId: where.companyId, isSystem: false, rolePermissions: methods.map(key => ({ permission: { key } })) } }] }));
  database.companyPaymentSetting.findFirst.mockReset().mockResolvedValue({ onlinePaymentsEnabled: true, defaultProvider: "STRIPE", allowProviderOverride: false });
  database.paymentProviderConfig.findFirst.mockReset().mockResolvedValue(row);
  database.paymentProviderConfig.findMany.mockReset().mockResolvedValue([row]);
  jest.mocked(decryptSecret).mockReset().mockReturnValue("sk_SYNTHETIC_CANARY");
});
afterAll(() => { if (oldEnabled === undefined) delete process.env.PAYMENTS_ENABLED; else process.env.PAYMENTS_ENABLED = oldEnabled; });
afterEach(() => {
  expect(database.companyMembership.findMany).not.toHaveBeenCalled(); expect(database.$transaction).not.toHaveBeenCalled();
  for (const model of ["companyPaymentSetting", "paymentProviderConfig", "order", "paymentIntent", "paymentLedgerEntry", "outboxEvent", "auditLog"])
    for (const method of ["create", "upsert", "update", "updateMany", "delete"]) expect(database[model][method]).not.toHaveBeenCalled();
});
function scoped(where: any, user: any) {
  expect(where).toMatchObject({ companyId: user.companyId, company: { is: { tenantId: user.tenantId,
    id: user.companyId, type: "company", isActive: true, tenant: { is: { status: "active" } } } } });
}
it.each([a, b, sameTenant])("reads use only the exact selected context even for the same human", async user => {
  await policy({ user }); await list({ user }); await available({ user }); await localTest({ user, id: row.id });
  for (const call of database.companyPaymentSetting.findFirst.mock.calls) scoped(call[0].where, user);
  for (const call of [...database.paymentProviderConfig.findFirst.mock.calls, ...database.paymentProviderConfig.findMany.mock.calls]) scoped(call[0].where, user);
  expect(database.companyMembership.findFirst.mock.calls[0][0].where).toMatchObject({ id: user.companyMembershipId,
    userId: user.id, companyId: user.companyId, tenantId: user.tenantId, tenantMembershipId: user.tenantMembershipId,
    tenant: { status: "active" }, tenantMembership: { userId: user.id, status: "active" } });
});
it("configuration responses never expose credentials or signing values including adapter surplus fields", async () => {
  for (const result of [await list({ user: a }), await available({ user: a }), await localTest({ user: a, id: row.id })]) {
    const json = JSON.stringify(result); expect(json).not.toContain("SYNTHETIC_CANARY"); expect(json).not.toContain("secretMasked");
    expect(json).not.toContain("secretEncrypted");
  }
  const query = database.paymentProviderConfig.findMany.mock.calls[0][0]; expect(query.take).toBe(8);
  expect(query.select).not.toHaveProperty("serviceId"); expect(query.select).not.toHaveProperty("secretMasked");
});
it.each([policy, list, available])("a foreign requested company cannot select credentials or policy", async fn => {
  await expect(fn({ user: a, companyId: b.companyId })).rejects.toMatchObject({ statusCode: 403 });
  expect(database.paymentProviderConfig.findMany).not.toHaveBeenCalled(); expect(database.companyPaymentSetting.findFirst).not.toHaveBeenCalled();
});
it.each([null, { ...a, tenantId: null }, { ...a, membershipId: "other" }, { ...a, tenantMembershipId: null }])("missing/partial context denies all paths before business reads", async user => {
  for (const fn of [policy, list, available, localTest, patch, create, policyWrite])
    await expect((fn as any)({ user, id: row.id, companyId: a.companyId })).rejects.toMatchObject({ statusCode: 403 });
  expect(database.paymentProviderConfig.findFirst).not.toHaveBeenCalled(); expect(database.paymentProviderConfig.findMany).not.toHaveBeenCalled();
  expect(database.companyPaymentSetting.findFirst).not.toHaveBeenCalled(); expect(decryptSecret).not.toHaveBeenCalled();
});
it.each(["revoked", "permission", "scope", "foreign-scope"])("fresh %s denial cannot use token/global grants", async kind => {
  const membership = await database.companyMembership.findFirst({ where: a });
  database.companyMembership.findFirst.mockResolvedValue(kind === "revoked" ? null : { ...membership,
    ...(kind === "permission" ? { roles: [] } : {}),
    ...(kind === "scope" ? { scopes: [] } : kind === "foreign-scope" ? { scopes: [{ scopeType: "company", scopeRefId: b.companyId }] } : {}),
  });
  await expect(list({ user: a })).rejects.toMatchObject({ statusCode: 403 });
  await expect(localTest({ user: a, id: row.id })).rejects.toMatchObject({ statusCode: 403 });
  await expect(patch({ user: a, id: row.id })).rejects.toMatchObject({ statusCode: 403 });
  expect(database.paymentProviderConfig.findFirst).not.toHaveBeenCalled(); expect(decryptSecret).not.toHaveBeenCalled();
});
it.each([patch, localTest])("foreign/null/unowned config returns no secrets or effects", async fn => {
  database.paymentProviderConfig.findFirst.mockResolvedValue(null);
  await expect(fn({ user: a, id: "foreign" })).rejects.toMatchObject({ statusCode: 404 });
  scoped(database.paymentProviderConfig.findFirst.mock.calls[0][0].where, a); expect(decryptSecret).not.toHaveBeenCalled();
});
it.each([patch, localTest])("missing id never collapses to a first owned configuration", async fn => {
  await expect(fn({ user: a, id: undefined as any })).rejects.toMatchObject({ statusCode: 400 });
  expect(database.paymentProviderConfig.findFirst).not.toHaveBeenCalled(); expect(decryptSecret).not.toHaveBeenCalled();
});
it.each([create, policyWrite, patch])("even an authorized manager cannot self-accept configuration", async fn => {
  await expect((fn as any)({ user: a, id: row.id, companyId: a.companyId, secret: "synthetic" }))
    .rejects.toMatchObject({ statusCode: 409, code: "PAYMENT_CONFIGURATION_APPROVAL_REQUIRED" });
  expect(decryptSecret).not.toHaveBeenCalled();
});
it.each([create, policyWrite])("foreign write intent fails before approval/configuration access", async fn => {
  await expect((fn as any)({ user: a, companyId: b.companyId })).rejects.toMatchObject({ statusCode: 403 });
  expect(database.paymentProviderConfig.findFirst).not.toHaveBeenCalled();
});
it("missing policy fails closed without creating defaults or advertising providers", async () => {
  database.companyPaymentSetting.findFirst.mockResolvedValue(null);
  expect(await policy({ user: a })).toMatchObject({ onlinePaymentsEnabled: false, effectiveOnlinePaymentsEnabled: false, allowProviderOverride: false });
  expect(await available({ user: a })).toEqual([]); expect(database.paymentProviderConfig.findMany).not.toHaveBeenCalled();
});
it.each([false, null])("disabled/missing policy cannot advertise checkout", async enabled => {
  database.companyPaymentSetting.findFirst.mockResolvedValue({ onlinePaymentsEnabled: enabled });
  expect(await available({ user: a })).toEqual([]); expect(database.paymentProviderConfig.findMany).not.toHaveBeenCalled();
});
it("available provider query excludes unsupported providers and respects a locked policy", async () => {
  await available({ user: a }); expect(database.paymentProviderConfig.findMany.mock.calls[0][0]).toMatchObject({ take: 2, where: { provider: "STRIPE", isEnabled: true } });
  database.paymentProviderConfig.findMany.mockClear(); database.companyPaymentSetting.findFirst.mockResolvedValue({ onlinePaymentsEnabled: true, defaultProvider: "PAYME", allowProviderOverride: false });
  expect(await available({ user: a })).toEqual([]); expect(database.paymentProviderConfig.findMany).not.toHaveBeenCalled();
});
it("credential decryption failures are sanitized and local test does not claim transport verification", async () => {
  jest.mocked(decryptSecret).mockImplementation(() => { throw Error("SYNTHETIC_CANARY"); });
  const result = await localTest({ user: a, id: row.id });
  expect(result).toMatchObject({ healthy: false, validationMode: "local-configuration-only", issues: ["Stored credential could not be validated"] });
  expect(JSON.stringify(result)).not.toContain("SYNTHETIC_CANARY");
});
it.each(["STRIPE", "CLICK", "PAYME", "UZUM"] as const)("retained %s local format rules accept synthetic configured values", provider => {
  expect(collectProviderConfigIssues({ provider, merchantId: "synthetic", serviceId: "whsec_synthetic", accountId: "synthetic", secret: "sk_synthetic" })).toEqual([]);
});
it.each(["STRIPE", "CLICK", "PAYME", "UZUM"] as const)("retained %s local format rules reject absent credentials", provider => {
  expect(collectProviderConfigIssues({ provider })).not.toHaveLength(0);
});
