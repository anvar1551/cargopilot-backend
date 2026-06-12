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

function optionalEnv(name: string) {
  const value = String(process.env[name] || "").trim();
  return value || null;
}

async function assertFakeCarrierReady(baseUrl: string) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/health`);
  if (!response.ok) {
    throw new Error(`fake carrier health failed: ${response.status}`);
  }
}

function getLoginCompanyId(admin: Awaited<ReturnType<typeof login>>) {
  const companyId = typeof admin.user?.companyId === "string" ? admin.user.companyId.trim() : "";
  return companyId || null;
}

async function resolveSmokeOrderLeg(args: {
  companyId: string;
  orderId?: string | null;
  legId?: string | null;
}) {
  if (args.orderId || args.legId) {
    const leg = await prisma.orderLeg.findFirst({
      where: {
        ...(args.legId ? { id: args.legId } : {}),
        ...(args.orderId ? { orderId: args.orderId } : {}),
      },
      orderBy: { sequence: "asc" },
      select: {
        id: true,
        orderId: true,
        sequence: true,
        carrierBookingStatus: true,
        order: { select: { orderNumber: true } },
      },
    });
    if (!leg) {
      throw new Error(`CARRIER_SMOKE_ORDER_ID/CARRIER_SMOKE_LEG_ID do not match an existing leg`);
    }
    return leg;
  }

  const order = await prisma.order.findFirst({
    where: {
      OR: [{ ownerOrgId: args.companyId }, { assignedOrgId: args.companyId }],
      senderName: { not: null },
      senderPhone: { not: null },
      receiverName: { not: null },
      receiverPhone: { not: null },
      pickupAddress: { not: "" },
      dropoffAddress: { not: "" },
      legs: { some: {} },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      orderNumber: true,
      legs: {
        orderBy: { sequence: "asc" },
        take: 1,
        select: {
          id: true,
          orderId: true,
          sequence: true,
          carrierBookingStatus: true,
          order: { select: { orderNumber: true } },
        },
      },
    },
  });

  const leg = order?.legs[0];
  if (!leg) {
    throw new Error(
      "Could not auto-detect an order leg. Set CARRIER_SMOKE_COMPANY_ID, CARRIER_SMOKE_ORDER_ID, and CARRIER_SMOKE_LEG_ID explicitly.",
    );
  }
  return leg;
}

function parseSimulationResult(text: string) {
  try {
    return JSON.parse(text) as { status?: number; body?: string };
  } catch {
    return { body: text };
  }
}

async function main() {
  const adminEmail = required("INTEGRATION_ADMIN_EMAIL");
  const adminPassword = required("INTEGRATION_ADMIN_PASSWORD");
  const fakeCarrierBaseUrl = String(process.env.FAKE_CARRIER_BASE_URL || "http://localhost:4100").replace(/\/$/, "");
  const webhookSecret = String(process.env.FAKE_CARRIER_WEBHOOK_SECRET || "dev_fake_carrier_secret").trim();
  const providerCode = optionalEnv("FAKE_CARRIER_PROVIDER_CODE") || `fake_carrier_smoke_${Date.now()}`;

  logStep("Fake carrier health");
  await assertFakeCarrierReady(fakeCarrierBaseUrl);
  console.log(pretty({ fakeCarrierBaseUrl, providerCode }));

  logStep("Admin login");
  const admin = await login(adminEmail, adminPassword);
  const companyId = optionalEnv("CARRIER_SMOKE_COMPANY_ID") || getLoginCompanyId(admin);
  if (!companyId) {
    throw new Error("Could not resolve companyId from login response. Set CARRIER_SMOKE_COMPANY_ID.");
  }

  logStep("Resolve smoke order leg");
  const smokeLeg = await resolveSmokeOrderLeg({
    companyId,
    orderId: optionalEnv("CARRIER_SMOKE_ORDER_ID"),
    legId: optionalEnv("CARRIER_SMOKE_LEG_ID"),
  });
  const orderId = smokeLeg.orderId;
  const legId = smokeLeg.id;
  console.log(pretty({
    companyId,
    orderId,
    orderNumber: smokeLeg.order.orderNumber,
    legId,
    legSequence: smokeLeg.sequence,
    previousCarrierBookingStatus: smokeLeg.carrierBookingStatus,
  }));

  logStep("Upsert active fake carrier provider");
  const provider = await httpJson<ProviderResponse>({
    method: "POST",
    path: "/api/integrations/providers",
    token: admin.token,
    body: {
      companyId,
      domain: "carrier",
      providerCode,
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
  const runId = `smoke-${Date.now()}`;
  const webhookPayload = {
    eventId: `fake-status-${legId}-${runId}`,
    eventType: "carrier.status.updated",
    occurredAt: new Date().toISOString(),
    aggregateType: "shipment",
    aggregateId: legId,
    partnerShipmentId: bookedLeg.carrierRef,
    trackingNumber: bookedLeg.carrierTrackingNumber,
    statusCode: "in_transit",
    statusLabel: `In transit ${runId}`,
    location: "Fake Carrier Hub",
  };
  const trackingCountBefore = await prisma.tracking.count({
    where: {
      orderLegId: legId,
      note: { contains: runId },
    },
  });
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
  const firstWebhookResult = parseSimulationResult(webhookText);
  if (firstWebhookResult.status !== 202) {
    throw new Error(`CargoPilot webhook was not accepted: ${webhookText}`);
  }
  console.log(webhookText);

  logStep("Send duplicate signed carrier status webhook");
  const duplicateWebhookResult = await fetch(`${fakeCarrierBaseUrl}/webhooks/simulate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      targetUrl: webhookTarget,
      secret: webhookSecret,
      payload: webhookPayload,
    }),
  });
  const duplicateWebhookText = await duplicateWebhookResult.text();
  if (!duplicateWebhookResult.ok) {
    throw new Error(`fake duplicate webhook simulation failed: ${duplicateWebhookResult.status} ${duplicateWebhookText}`);
  }
  const secondWebhookResult = parseSimulationResult(duplicateWebhookText);
  if (secondWebhookResult.status !== 200 || !String(secondWebhookResult.body || "").includes("duplicate")) {
    throw new Error(`CargoPilot duplicate webhook was not idempotent: ${duplicateWebhookText}`);
  }
  console.log(duplicateWebhookText);

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
  const trackingCountAfter = await prisma.tracking.count({
    where: {
      orderLegId: legId,
      note: { contains: runId },
    },
  });
  if (trackingCountAfter - trackingCountBefore !== 1) {
    throw new Error(
      `duplicate webhook created duplicate tracking events: before=${trackingCountBefore} after=${trackingCountAfter}`,
    );
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
