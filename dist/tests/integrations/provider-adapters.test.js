"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = __importDefault(require("http"));
const provider_adapters_1 = require("../../src/modules/integrations-core/application/provider-adapters");
function createCarrierInput() {
    return {
        externalOrderId: "ORDER-1",
        sender: {
            name: "Sender",
            phone: "+998900000000",
            address: "Sender street",
        },
        receiver: {
            name: "Receiver",
            phone: "+998911111111",
            address: "Receiver street",
        },
        parcels: [{ weightKg: 2 }],
        currency: "USD",
    };
}
async function withServer(handler, run) {
    const server = http_1.default.createServer(handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
        await run(`http://127.0.0.1:${port}`);
    }
    finally {
        await new Promise((resolve) => server.close(() => resolve()));
    }
}
function adapter(baseUrl, timeoutMs = 500) {
    return new provider_adapters_1.HttpCarrierAdapter({
        providerCode: "fake_carrier",
        baseUrl,
        timeoutMs,
    });
}
describe("HTTP carrier adapter", () => {
    const context = {
        requestId: "req_1",
        companyId: "company_1",
        idempotencyKey: "idem_1",
        initiatedBy: "worker",
    };
    it("maps shipment creation success", async () => {
        await withServer((_request, response) => {
            response.writeHead(201, { "content-type": "application/json" });
            response.end(JSON.stringify({
                partnerShipmentId: "ps_1",
                trackingNumber: "TN1",
                labelUrl: "https://example.test/label.pdf",
            }));
        }, async (baseUrl) => {
            const result = await adapter(baseUrl).createShipment(createCarrierInput(), context);
            expect(result.ok).toBe(true);
            expect(result.retryable).toBe(false);
            expect(result.data?.partnerShipmentId).toBe("ps_1");
            expect(result.data?.trackingNumber).toBe("TN1");
        });
    });
    it("marks missing provider shipment id as permanent failure", async () => {
        await withServer((_request, response) => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ trackingNumber: "TN1" }));
        }, async (baseUrl) => {
            const result = await adapter(baseUrl).createShipment(createCarrierInput(), context);
            expect(result.ok).toBe(false);
            expect(result.retryable).toBe(false);
            expect(result.message).toMatch(/partnerShipmentId/i);
        });
    });
    it.each([
        [400, false],
        [429, true],
        [500, true],
    ])("maps HTTP %s retryability", async (statusCode, retryable) => {
        await withServer((_request, response) => {
            response.writeHead(statusCode, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: `status ${statusCode}` }));
        }, async (baseUrl) => {
            const result = await adapter(baseUrl).createShipment(createCarrierInput(), context);
            expect(result.ok).toBe(false);
            expect(result.retryable).toBe(retryable);
            expect(result.providerStatusCode).toBe(statusCode);
        });
    });
    it("throws provider timeout for dispatcher retry handling", async () => {
        await withServer((_request, _response) => {
            // Intentionally never respond.
        }, async (baseUrl) => {
            await expect(adapter(baseUrl, 50).createShipment(createCarrierInput(), context)).rejects.toThrow(/timed out/i);
        });
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
        const config = (0, provider_adapters_1.resolveProviderHttpConfig)({
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
        const config = (0, provider_adapters_1.resolveProviderHttpConfig)({
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
        const config = (0, provider_adapters_1.resolveProviderHttpConfig)({
            domain: "carrier",
            providerCode: "fake_carrier",
            timeoutMs: 1000,
            secretConfig: null,
        });
        expect(config?.baseUrl).toBe("https://env.example.test");
        expect(config?.apiKey).toBe("env-api-key");
    });
});
