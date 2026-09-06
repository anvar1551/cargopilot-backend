jest.mock("../../src/modules/integrations-core/application/integration-http-client", () => ({ integrationHttpJson: jest.fn() }));
import { integrationHttpJson } from "../../src/modules/integrations-core/application/integration-http-client";
import { HttpCarrierAdapter, resolveProviderHttpConfig } from "../../src/modules/integrations-core/application/provider-adapters";

const input = () => ({ externalOrderId: "ORDER-1", sender: { name: "Sender", phone: "+998900000000", address: "Sender street" }, receiver: { name: "Receiver", phone: "+998911111111", address: "Receiver street" }, parcels: [{ weightKg: 2 }], currency: "USD" });
const context = { requestId: "req_1", companyId: "company_1", idempotencyKey: "idem_1", initiatedBy: "worker" as const };
const adapter = () => new HttpCarrierAdapter({ providerCode: "fake_carrier", baseUrl: "https://carrier.example.test", timeoutMs: 500 });

describe("HTTP carrier adapter with mocked transport", () => {
  it("maps shipment creation success and supplies the server provider policy identity", async () => {
    (integrationHttpJson as jest.Mock).mockResolvedValue({ statusCode: 201, body: { partnerShipmentId: "ps_1", trackingNumber: "TN1", labelUrl: "https://example.test/label.pdf" } });
    await expect(adapter().createShipment(input(), context)).resolves.toMatchObject({ ok: true, retryable: false, data: { partnerShipmentId: "ps_1", trackingNumber: "TN1" } });
    expect(integrationHttpJson).toHaveBeenCalledWith(expect.objectContaining({ providerCode: "fake_carrier", url: expect.stringContaining("https://carrier.example.test/") }));
  });
  it("marks missing shipment ID as permanent failure", async () => {
    (integrationHttpJson as jest.Mock).mockResolvedValue({ statusCode: 200, body: { trackingNumber: "TN1" } });
    await expect(adapter().createShipment(input(), context)).resolves.toMatchObject({ ok: false, retryable: false });
  });
  it.each([[400, false], [429, true], [500, true]])("maps HTTP %s retryability", async (statusCode, retryable) => {
    (integrationHttpJson as jest.Mock).mockResolvedValue({ statusCode, body: {} });
    await expect(adapter().createShipment(input(), context)).resolves.toMatchObject({ ok: false, retryable, providerStatusCode: statusCode });
  });
  it("propagates transport timeout for dispatcher retry handling", async () => {
    (integrationHttpJson as jest.Mock).mockRejectedValue(new Error("Integration request timed out"));
    await expect(adapter().createShipment(input(), context)).rejects.toThrow("timed out");
  });
});

describe("provider HTTP config resolution", () => {
  const previousEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...previousEnv };
  });

  it("uses encrypted DB secret payload before any env fallback", () => {
    process.env.INTEGRATION_ALLOW_ENV_PROVIDER_FALLBACK = "true";
    process.env.INTEGRATION_CARRIER_BASE_URL_FAKE_CARRIER = "https://env.example.test";
    process.env.INTEGRATION_CARRIER_TOKEN_FAKE_CARRIER = "env-token";

    const config = resolveProviderHttpConfig({
      domain: "carrier",
      providerCode: "fake_carrier",
      timeoutMs: 1000,
      secretConfig: {
        baseUrl: "https://db.example.test",
        token: "db-token",
      },
    });

    expect(config?.baseUrl).toBe("https://db.example.test");
    expect(config?.token).toBe("db-token");
  });

  it("does not read provider credentials from env unless fallback is explicitly enabled", () => {
    delete process.env.INTEGRATION_ALLOW_ENV_PROVIDER_FALLBACK;
    process.env.INTEGRATION_CARRIER_BASE_URL_FAKE_CARRIER = "https://env.example.test";

    const config = resolveProviderHttpConfig({
      domain: "carrier",
      providerCode: "fake_carrier",
      timeoutMs: 1000,
      secretConfig: null,
    });

    expect(config).toBeNull();
  });

  it("can use env provider credentials when local fallback is explicitly enabled", () => {
    process.env.INTEGRATION_ALLOW_ENV_PROVIDER_FALLBACK = "true";
    process.env.INTEGRATION_CARRIER_BASE_URL_FAKE_CARRIER = "https://env.example.test";
    process.env.INTEGRATION_CARRIER_API_KEY_FAKE_CARRIER = "env-api-key";

    const config = resolveProviderHttpConfig({
      domain: "carrier",
      providerCode: "fake_carrier",
      timeoutMs: 1000,
      secretConfig: null,
    });

    expect(config?.baseUrl).toBe("https://env.example.test");
    expect(config?.apiKey).toBe("env-api-key");
  });
});
