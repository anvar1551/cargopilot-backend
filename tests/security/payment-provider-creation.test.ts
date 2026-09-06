const mockStripeCreate = jest.fn();
jest.mock("stripe", () => ({ __esModule: true, default: jest.fn(() => ({ checkout: { sessions: { create: mockStripeCreate } } })) }));

import { ClickProviderAdapter } from "../../src/modules/payments-core/infrastructure/providers/clickAdapter";
import { StripeProviderAdapter } from "../../src/modules/payments-core/infrastructure/providers/stripeAdapter";

// Network methods are replaced before invoking adapters. No provider access.
const intent: any = { id: "intent-a", companyId: "company-a", orderId: "order-a", currency: "UZS", amountMinor: 9007199254740993n };
const config: any = { serviceId: "fixture-service", merchantId: "fixture-merchant", accountId: "fixture-account", secretPlain: "fixture-only" };
afterEach(() => jest.restoreAllMocks());

it("serializes CLICK creation money as an exact JSON numeric lexeme and retains its abort signal", async () => {
  const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ invoice_id: "invoice-a" }) } as any);
  await new ClickProviderAdapter().createPayment({ config, intent });
  const request = fetchMock.mock.calls[0][1]!;
  expect(request.body).toContain('"amount":90071992547409.93');
  expect(request.signal).toBeInstanceOf(AbortSignal);
});

it.each([
  { ok: false, status: 503, payload: {} },
  { ok: true, status: 200, payload: { error_code: -1 } },
])("does not manufacture checkout success from a rejected/malformed CLICK result %p", async (response) => {
  jest.spyOn(globalThis, "fetch").mockResolvedValue({ ...response, text: async () => JSON.stringify(response.payload) } as any);
  await expect(new ClickProviderAdapter().createPayment({ config, intent })).rejects.toThrow("outcome unknown");
});

it("passes a durable company/intent idempotency key to Stripe with exact safe minor units", async () => {
  mockStripeCreate.mockResolvedValue({ id: "session-a", url: "https://example.test/checkout" });
  await new StripeProviderAdapter().createPayment({ config, intent: { ...intent, currency: "USD", amountMinor: 120025n } });
  expect(mockStripeCreate).toHaveBeenCalledWith(expect.objectContaining({
    line_items: [expect.objectContaining({ price_data: expect.objectContaining({ unit_amount: 120025 }) })],
  }), { idempotencyKey: "cargopilot:company-a:intent-a" });
});
