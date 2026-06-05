import { createHmac } from "crypto";
import { createHmacWebhookVerifier } from "../../src/modules/integrations-core/infrastructure/verifiers/hmac-webhook.verifier";

function sign(rawBody: string, secret: string, timestamp: string) {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

describe("HMAC webhook verifier", () => {
  it("accepts a valid signed canonical carrier webhook", async () => {
    const secret = "unit-secret";
    const rawBody = JSON.stringify({
      eventId: "evt_1",
      eventType: "carrier.status.updated",
      aggregateType: "shipment",
      aggregateId: "leg_1",
      statusCode: "in_transit",
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const verifier = createHmacWebhookVerifier({
      providerCode: "fake_carrier",
      secret,
      maxSkewSeconds: 300,
    });

    const result = await verifier.verifyAndNormalize({
      headers: {
        "x-signature": sign(rawBody, secret, timestamp),
        "x-signature-timestamp": timestamp,
      },
      rawBody,
      companyHintId: "company_1",
    });

    expect(result.ok).toBe(true);
    expect(result.data?.eventId).toBe("evt_1");
    expect(result.data?.eventType).toBe("carrier.status.updated");
    expect(result.data?.companyId).toBe("company_1");
  });

  it("rejects invalid signatures", async () => {
    const verifier = createHmacWebhookVerifier({
      providerCode: "fake_carrier",
      secret: "unit-secret",
      maxSkewSeconds: 300,
    });

    const result = await verifier.verifyAndNormalize({
      headers: {
        "x-signature": "bad",
        "x-signature-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      rawBody: JSON.stringify({ eventId: "evt_bad" }),
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/signature/i);
  });

  it("rejects expired timestamps", async () => {
    const secret = "unit-secret";
    const rawBody = JSON.stringify({ eventId: "evt_expired" });
    const oldTimestamp = String(Math.floor((Date.now() - 10 * 60_000) / 1000));
    const verifier = createHmacWebhookVerifier({
      providerCode: "fake_carrier",
      secret,
      maxSkewSeconds: 60,
    });

    const result = await verifier.verifyAndNormalize({
      headers: {
        "x-signature": sign(rawBody, secret, oldTimestamp),
        "x-signature-timestamp": oldTimestamp,
      },
      rawBody,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/timestamp/i);
  });
});
