import { Prisma } from "@prisma/client";
import { createAuthorizedPayment, invoiceMinorUnits } from "../../src/modules/payments-core/application/payment-creation";
import { createPaymentIntentSchema, retryOrderPaymentSchema } from "../../src/modules/payments-core/shared/validation";

// In-process dependencies only. No PrismaClient, dotenv, Redis or provider adapter is instantiated.
const companyA = "10000000-0000-4000-8000-000000000001";
const companyB = "10000000-0000-4000-8000-000000000002";
const orderId = "20000000-0000-4000-8000-000000000001";
const warehouseA = "30000000-0000-4000-8000-000000000001";
const warehouseB = "30000000-0000-4000-8000-000000000002";
const key = "checkout-request-0001";

function fixture() {
  const user: any = { id: "user-a", membershipId: "membership-a", companyId: companyA };
  const membership: any = {
    companyId: companyA, scopes: [{ scopeType: "company", scopeRefId: companyA }],
    roles: [{ role: { companyId: companyA, isSystem: false, rolePermissions: [{ permission: { key: "payments.intents.create" } }] } }],
  };
  const order: any = { id: orderId, ownerOrgId: companyA, currentWarehouseId: warehouseA,
    customerEntityId: null, paymentType: "CARD", paymentState: "UNPAID", status: "pending" };
  const invoice: any = { id: "invoice-a", orderId, companyId: companyA, customerEntityId: null,
    status: "issued", issuedAt: new Date("2026-09-01T12:00:00Z"), issuedByUserId: "issuer-a", amount: new Prisma.Decimal("1200.25"), currency: "UZS" };
  const legalEntity: any = { id: "legal-a", companyId: companyA, isActive: true };
  const policy: any = { onlinePaymentsEnabled: true, defaultProvider: "PAYME", allowProviderOverride: false };
  const config: any = { id: "config-a", companyId: companyA, provider: "PAYME", environment: "TEST", isEnabled: true, secretPlain: "fixture-only" };
  const intents: any[] = [];
  const db: any = {
    companyMembership: { findFirst: jest.fn(async () => membership) },
    order: { findUnique: jest.fn(async () => order), update: jest.fn() },
    invoice: { findUnique: jest.fn(async () => invoice) },
    financeLegalEntity: { findUnique: jest.fn(async () => legalEntity) },
    companyPaymentSetting: { findUnique: jest.fn(async () => policy) },
    paymentIntent: {
      findUnique: jest.fn(async ({ where }: any) => intents.find((item) => where.id ? item.id === where.id :
        item.companyId === where.companyId_idempotencyKey.companyId && item.idempotencyKey === where.companyId_idempotencyKey.idempotencyKey) ?? null),
      findFirst: jest.fn(async () => intents[0] ?? null),
      create: jest.fn(async ({ data }: any) => {
        const item = { id: "intent-a", providerCheckoutUrl: null, providerPaymentId: null, ...data };
        intents.push(item); return item;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const item = intents.find((row) => row.id === where.id && row.status === where.status);
        if (item) Object.assign(item, Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)));
        return { count: item ? 1 : 0 };
      }),
    },
    paymentAttempt: { create: jest.fn(async () => ({})) },
    $executeRaw: jest.fn(async () => 0),
    $queryRaw: jest.fn(async () => [{ id: orderId }]),
  };
  db.$transaction = jest.fn(async (work: any) => work(db));
  const createPayment = jest.fn(async (): Promise<any> => ({ checkoutUrl: "https://checkout.example.test/intent-a", providerPaymentId: "external-a" }));
  const resolveConfig = jest.fn(async () => config);
  const adapter = jest.fn(() => ({ createPayment }));
  const call = (input: any = {}) => createAuthorizedPayment({ user, input: { orderId, idempotencyKey: key, ...input } }, { db, resolveConfig, adapter } as any);
  const noEffects = () => {
    expect(db.paymentIntent.create).not.toHaveBeenCalled(); expect(db.paymentIntent.updateMany).not.toHaveBeenCalled();
    expect(db.paymentAttempt.create).not.toHaveBeenCalled(); expect(db.order.update).not.toHaveBeenCalled();
    expect(createPayment).not.toHaveBeenCalled();
  };
  return { user, membership, order, invoice, legalEntity, policy, config, intents, db, createPayment, resolveConfig, adapter, call, noEffects };
}

const previousEnabled = process.env.PAYMENTS_ENABLED;
const previousEnvironment = process.env.PAYMENTS_ENVIRONMENT;
beforeEach(() => { process.env.PAYMENTS_ENABLED = "true"; process.env.PAYMENTS_ENVIRONMENT = "TEST"; });
afterAll(() => {
  if (previousEnabled === undefined) delete process.env.PAYMENTS_ENABLED; else process.env.PAYMENTS_ENABLED = previousEnabled;
  if (previousEnvironment === undefined) delete process.env.PAYMENTS_ENVIRONMENT; else process.env.PAYMENTS_ENVIRONMENT = previousEnvironment;
});

it("creates a company-owned invoice payment using exact amount and authoritative legal entity", async () => {
  const f = fixture(); const result = await f.call();
  expect(result).toMatchObject({ paymentIntentId: "intent-a", reused: false, status: "requires_action" });
  expect(f.intents[0]).toMatchObject({ amountMinor: 120025n, currency: "UZS", companyId: companyA,
    metadataJson: { invoiceId: "invoice-a", legalEntityId: "legal-a" } });
  expect(f.db.companyMembership.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: "user-a", status: "active", companyId: companyA }) }));
  expect(f.resolveConfig).toHaveBeenCalledWith({ companyId: companyA, provider: "PAYME", environment: "TEST" }, f.db);
  expect(f.createPayment).toHaveBeenCalledTimes(1);
});

it("permits a matching warehouse scope only within the owning company", async () => {
  const f = fixture(); f.membership.scopes = [{ scopeType: "warehouse", scopeRefId: warehouseA }];
  await expect(f.call()).resolves.toMatchObject({ reused: false });
});

it.each([
  ["missing membership", (f: ReturnType<typeof fixture>) => { f.user.membershipId = null; }],
  ["revoked membership", (f: ReturnType<typeof fixture>) => { f.db.companyMembership.findFirst.mockResolvedValue(null); }],
  ["stale token permission", (f: ReturnType<typeof fixture>) => { f.user.permissionCodes = ["payments.intents.create"]; f.membership.roles = []; }],
  ["foreign role", (f: ReturnType<typeof fixture>) => { f.membership.roles[0].role.companyId = companyB; }],
  ["missing scope", (f: ReturnType<typeof fixture>) => { f.membership.scopes = []; }],
  ["foreign warehouse", (f: ReturnType<typeof fixture>) => { f.membership.scopes = [{ scopeType: "warehouse", scopeRefId: warehouseB }]; }],
  ["foreign order", (f: ReturnType<typeof fixture>) => { f.order.ownerOrgId = companyB; }],
  ["ownerless legacy order", (f: ReturnType<typeof fixture>) => { f.order.ownerOrgId = null; }],
  ["foreign invoice", (f: ReturnType<typeof fixture>) => { f.invoice.companyId = companyB; }],
  ["foreign invoice customer", (f: ReturnType<typeof fixture>) => { f.invoice.customerEntityId = "foreign-master"; }],
  ["no issued invoice", (f: ReturnType<typeof fixture>) => { f.invoice.status = "pending"; }],
  ["no issuer", (f: ReturnType<typeof fixture>) => { f.invoice.issuedByUserId = null; }],
  ["inactive legal entity", (f: ReturnType<typeof fixture>) => { f.legalEntity.isActive = false; }],
  ["foreign legal entity", (f: ReturnType<typeof fixture>) => { f.legalEntity.companyId = companyB; }],
  ["paid invoice", (f: ReturnType<typeof fixture>) => { f.invoice.status = "paid"; }],
  ["cancelled order", (f: ReturnType<typeof fixture>) => { f.order.status = "cancelled"; }],
  ["manual payment", (f: ReturnType<typeof fixture>) => { f.order.paymentType = "CASH"; }],
  ["missing explicit policy", (f: ReturnType<typeof fixture>) => { f.db.companyPaymentSetting.findUnique.mockResolvedValue(null); }],
  ["foreign provider company", (f: ReturnType<typeof fixture>) => { f.config.companyId = companyB; }],
  ["provider environment mismatch", (f: ReturnType<typeof fixture>) => { f.config.environment = "PRODUCTION"; }],
  ["missing environment", () => { delete process.env.PAYMENTS_ENVIRONMENT; }],
  ["sub-minor invoice precision", (f: ReturnType<typeof fixture>) => { f.invoice.amount = new Prisma.Decimal("12.001"); }],
] as const)("rejects %s without business writes or provider effects", async (_name, change) => {
  const f = fixture(); change(f); await expect(f.call()).rejects.toBeDefined(); f.noEffects();
});

it.each([{ companyId: companyB }, { amountMinor: 1n }, { currency: "USD" }, { status: "SUCCEEDED" },
  { paid: true }, { legalEntityId: "other" }, { amountMinor: 120025 }, { provider: "STRIPE" }])(
  "rejects manipulated input %p without writes/effects", async (input) => {
    const f = fixture(); await expect(f.call(input)).rejects.toBeDefined(); f.noEffects();
  },
);

it("matching retries return the persisted result without writes or repeat provider operations", async () => {
  const f = fixture(); await f.call({ metadata: { a: 1, b: 2 } });
  f.db.paymentIntent.create.mockClear(); f.db.paymentIntent.updateMany.mockClear(); f.db.paymentAttempt.create.mockClear(); f.createPayment.mockClear();
  await expect(f.call({ amountMinor: 120025n, currency: "UZS", companyId: companyA, metadata: { b: 2, a: 1 } })).resolves.toMatchObject({ reused: true, paymentIntentId: "intent-a" });
  f.noEffects();
});

it("matching retries of a settled invoice return existing state without resetting the order", async () => {
  const f = fixture(); await f.call(); f.intents[0].status = "SUCCEEDED"; f.invoice.status = "paid"; f.order.paymentState = "PAID";
  await expect(f.call()).resolves.toMatchObject({ status: "succeeded", reused: true });
  expect(f.db.order.update).not.toHaveBeenCalled(); expect(f.createPayment).toHaveBeenCalledTimes(1);
});

it.each([{ metadata: { changed: true } }, { provider: "PAYME" }, { returnUrl: "https://example.test/different" },
  { orderId: "20000000-0000-4000-8000-000000000002" }])("rejects conflicting key reuse %j", async (input) => {
  const f = fixture(); await f.call();
  if (input.orderId) { f.order.id = input.orderId; f.invoice.orderId = input.orderId; }
  f.db.paymentIntent.create.mockClear(); f.db.paymentIntent.updateMany.mockClear(); f.db.paymentAttempt.create.mockClear(); f.createPayment.mockClear();
  await expect(f.call(input)).rejects.toMatchObject({ statusCode: 409 }); f.noEffects();
});

it("rejects changed invoice authority on the same key", async () => {
  const f = fixture(); await f.call(); f.invoice.amount = new Prisma.Decimal("999");
  await expect(f.call()).rejects.toMatchObject({ statusCode: 409 }); expect(f.createPayment).toHaveBeenCalledTimes(1);
});

it.each(["cancelled", "returned"])("does not re-expose checkout for a now-%s order on matching reuse", async (status) => {
  const f = fixture(); await f.call(); f.order.status = status;
  await expect(f.call()).rejects.toMatchObject({ statusCode: 409 }); expect(f.createPayment).toHaveBeenCalledTimes(1);
});

it("does not dispatch a second key for an already reserved order", async () => {
  const f = fixture(); await f.call(); await expect(f.call({ idempotencyKey: "checkout-request-0002" })).rejects.toMatchObject({ statusCode: 409 });
  expect(f.createPayment).toHaveBeenCalledTimes(1);
});

it("re-reads a simulated unique-constraint winner; this is mocked evidence, not a concurrency test", async () => {
  const f = fixture(); const create = f.db.paymentIntent.create.getMockImplementation()!;
  f.db.paymentIntent.create.mockImplementationOnce(async (args: any) => { await create(args); throw Object.assign(new Error("duplicate"), { code: "P2002" }); });
  await expect(f.call()).resolves.toMatchObject({ reused: true, status: "pending" });
  expect(f.createPayment).not.toHaveBeenCalled();
});

it("preserves an ambiguous provider outcome and prevents both same-key and different-key redispatch", async () => {
  const f = fixture(); f.createPayment.mockRejectedValue(new Error("SENSITIVE-PROVIDER-ERROR"));
  await expect(f.call()).resolves.toMatchObject({ status: "pending" });
  await expect(f.call()).resolves.toMatchObject({ status: "pending", reused: true });
  await expect(f.call({ idempotencyKey: "checkout-request-0002" })).rejects.toMatchObject({ statusCode: 409 });
  expect(f.createPayment).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(f.db.paymentAttempt.create.mock.calls)).not.toContain("SENSITIVE-PROVIDER-ERROR");
});

it("does not downgrade a callback settlement that wins before provider initiation finishes", async () => {
  const f = fixture(); f.createPayment.mockImplementation(async () => { f.intents[0].status = "SUCCEEDED"; return { checkoutUrl: "https://example.test/pay" }; });
  await expect(f.call()).resolves.toMatchObject({ status: "succeeded" }); expect(f.db.order.update).not.toHaveBeenCalled();
});

it("never dispatches if the reservation transaction fails", async () => {
  const f = fixture(); f.db.$transaction.mockRejectedValueOnce(new Error("rollback"));
  await expect(f.call()).rejects.toThrow("rollback"); f.noEffects();
});

it("converts high-precision stored Decimal values without floating-point rounding", () => {
  expect(invoiceMinorUnits(new Prisma.Decimal("90071992547409.93"), "UZS")).toBe(9007199254740993n);
  expect(() => invoiceMinorUnits(new Prisma.Decimal("1.0001"), "USD")).toThrow("exactly");
  expect(() => invoiceMinorUnits(new Prisma.Decimal("0"), "USD")).toThrow();
  expect(() => invoiceMinorUnits(new Prisma.Decimal("-1"), "USD")).toThrow();
});

it("requires a stable retry key and rejects financial fields on the retry HTTP contract", () => {
  expect(retryOrderPaymentSchema.safeParse({}).success).toBe(false);
  expect(retryOrderPaymentSchema.safeParse({ idempotencyKey: key, paid: true }).success).toBe(false);
  expect(retryOrderPaymentSchema.safeParse({ idempotencyKey: key }).success).toBe(true);
  expect(createPaymentIntentSchema.safeParse({ orderId, idempotencyKey: key, amountMinor: "120025" }).success).toBe(true);
});
