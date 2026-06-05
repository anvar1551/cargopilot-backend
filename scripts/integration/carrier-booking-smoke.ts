import "dotenv/config";
import prisma from "../../src/config/prismaClient";
import { processIntegrationOutboxBatchOnce } from "../../src/modules/integrations-core/infrastructure/integration-outbox.publisher";
import { getBaseUrl, getRequiredEnv, httpJson, logStep, login, pretty, sleep } from "./helpers";

type ProviderResponse = {
  id: string;
  companyId: string;
  providerCode: string;
  domain: string;
  environment: string;
  status: string;
};

type BookingResponse = {
  leg: {
    id: string;
    carrierBookingStatus: string;
    carrierProviderId?: string | null;
  };
  outbox: {
    id: string;
    status: string;
    idempotencyKey: string;
  };
};

function required(name: string) {
  return getRequiredEnv(name);
}

async function assertFakeCarrierReady(baseUrl: string) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/health`);
  if (!response.ok) {
    throw new Error(`fake carrier health failed: ${response.status}`);
  }
}

async function main() {
  const adminEmail = required("INTEGRATION_ADMIN_EMAIL");
  const adminPassword = required("INTEGRATION_ADMIN_PASSWORD");
  const companyId = required("CARRIER_SMOKE_COMPANY_ID");
  const orderId = required("CARRIER_SMOKE_ORDER_ID");
  const legId = required("CARRIER_SMOKE_LEG_ID");
  const fakeCarrierBaseUrl = String(process.env.FAKE_CARRIER_BASE_URL || "http://localhost:4100").replace(/\/$/, "");
  const webhookSecret = String(process.env.FAKE_CARRIER_WEBHOOK_SECRET || "dev_fake_carrier_secret").trim();

  logStep("Fake carrier health");
  await assertFakeCarrierReady(fakeCarrierBaseUrl);
  console.log(pretty({ fakeCarrierBaseUrl }));

  logStep("Admin login");
  const admin = await login(adminEmail, adminPassword);

  logStep("Upsert active fake carrier provider");
  const provider = await httpJson<ProviderResponse>({
    method: "POST",
    path: "/api/integrations/providers",
    token: admin.token,
    body: {
      companyId,
      domain: "carrier",
      providerCode: "fake_carrier",
      environment: "sandbox",
      status: "active",
      capabilities: ["create_shipment", "track", "cancel", "webhook"],
      timeoutMs: 5000,
    },
  });
  console.log(pretty(provider));

  logStep("Rotate provider secret");
  await httpJson({
    method: "POST",
    path: `/api/integrations/providers/${provider.id}/rotate-secret`,
    token: admin.token,
    body: {
      secretPayload: {
        baseUrl: fakeCarrierBaseUrl,
        webhookSecret,
        webhookSignatureHeader: "x-signature",
        webhookTimestampHeader: "x-signature-timestamp",
        webhookMaxSkewSeconds: 300,
      },
    },
  });

  logStep("Request carrier booking for leg");
  const booking = await httpJson<BookingResponse>({
    method: "POST",
    path: `/api/orders/${orderId}/legs/${legId}/carrier-booking`,
    token: admin.token,
    body: { providerId: provider.id },
  });
  console.log(pretty(booking));

  logStep("Process outbox once");
  const outboxResult = await processIntegrationOutboxBatchOnce();
  console.log(pretty(outboxResult));

  const bookedLeg = await prisma.orderLeg.findUnique({
    where: { id: legId },
    select: {
      id: true,
      status: true,
      carrierBookingStatus: true,
      carrierRef: true,
      carrierTrackingNumber: true,
    },
  });
  if (!bookedLeg || bookedLeg.carrierBookingStatus !== "booked" || !bookedLeg.carrierRef) {
    throw new Error(`leg was not booked: ${JSON.stringify(bookedLeg)}`);
  }
  console.log(pretty(bookedLeg));

  logStep("Send signed carrier status webhook");
  const webhookTarget = `${getBaseUrl()}/api/integrations/webhooks/${provider.id}`;
  const webhookPayload = {
    eventId: `fake-status-${legId}-${Date.now()}`,
    eventType: "carrier.status.updated",
    occurredAt: new Date().toISOString(),
    aggregateType: "shipment",
    aggregateId: legId,
    partnerShipmentId: bookedLeg.carrierRef,
    trackingNumber: bookedLeg.carrierTrackingNumber,
    statusCode: "in_transit",
    statusLabel: "In transit",
    location: "Fake Carrier Hub",
  };
  const webhookResult = await fetch(`${fakeCarrierBaseUrl}/webhooks/simulate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      targetUrl: webhookTarget,
      secret: webhookSecret,
      payload: webhookPayload,
    }),
  });
  const webhookText = await webhookResult.text();
  if (!webhookResult.ok) {
    throw new Error(`fake webhook simulation failed: ${webhookResult.status} ${webhookText}`);
  }
  console.log(webhookText);

  logStep("Process canonical webhook event once");
  await sleep(250);
  const webhookProcessResult = await processIntegrationOutboxBatchOnce();
  console.log(pretty(webhookProcessResult));

  const updatedLeg = await prisma.orderLeg.findUnique({
    where: { id: legId },
    select: {
      id: true,
      status: true,
      carrierBookingStatus: true,
      carrierRef: true,
      carrierTrackingNumber: true,
      carrierLastStatusAt: true,
      trackingEvents: {
        orderBy: { timestamp: "desc" },
        take: 3,
        select: { note: true, timestamp: true },
      },
    },
  });
  if (!updatedLeg || updatedLeg.status !== "in_transit") {
    throw new Error(`leg was not updated by webhook: ${JSON.stringify(updatedLeg)}`);
  }

  logStep("Carrier integration smoke passed");
  console.log(pretty(updatedLeg));
}

void main()
  .catch((error) => {
    console.error("[integration] carrier booking smoke failed:", error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
