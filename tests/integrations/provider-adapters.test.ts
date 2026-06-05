import http from "http";
import {
  HttpCarrierAdapter,
} from "../../src/modules/integrations-core/application/provider-adapters";

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

async function withServer(
  handler: http.RequestListener,
  run: (baseUrl: string) => Promise<void>,
) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function adapter(baseUrl: string, timeoutMs = 500) {
  return new HttpCarrierAdapter({
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
    initiatedBy: "worker" as const,
  };

  it("maps shipment creation success", async () => {
    await withServer((_request, response) => {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          partnerShipmentId: "ps_1",
          trackingNumber: "TN1",
          labelUrl: "https://example.test/label.pdf",
        }),
      );
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
      await expect(
        adapter(baseUrl, 50).createShipment(createCarrierInput(), context),
      ).rejects.toThrow(/timed out/i);
    });
  });
});
