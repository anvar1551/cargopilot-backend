import prisma from "../../config/prismaClient";
import { resolveCarrierRoutingRuleForOrderLeg } from "../integrations-core/application/carrier-routing.service";
import { bookCarrierForOrderLeg } from "./carrier-booking";
import type { Actor } from "./shared";

const db = prisma as any;

export type AutoBookCarrierForOrderLegResult =
  | {
      matched: false;
      booked: false;
      skippedReason: string;
    }
  | {
      matched: true;
      booked: false;
      skippedReason: string;
      rule: {
        id: string;
        name: string;
        providerId: string;
        providerCode: string;
      };
    }
  | {
      matched: true;
      booked: true;
      rule: {
        id: string;
        name: string;
        providerId: string;
        providerCode: string;
      };
      booking: Awaited<ReturnType<typeof bookCarrierForOrderLeg>>;
    };

export async function autoBookCarrierForOrderLeg(args: {
  orderId: string;
  legId: string;
  actor?: (Actor & { companyId?: string | null }) | null;
}): Promise<AutoBookCarrierForOrderLegResult> {
  const actor = args.actor ?? null;
  const companyId = String(args.actor?.companyId || "").trim();
  if (!actor || !companyId) {
    return { matched: false, booked: false, skippedReason: "company context missing" };
  }

  const leg = await db.orderLeg.findFirst({
    where: { id: args.legId, orderId: args.orderId },
    select: {
      id: true,
      carrierBookingStatus: true,
      carrierProviderId: true,
    },
  });
  if (!leg) {
    return { matched: false, booked: false, skippedReason: "leg not found" };
  }
  if (leg.carrierBookingStatus !== "not_requested") {
    return {
      matched: false,
      booked: false,
      skippedReason: `carrier booking already ${leg.carrierBookingStatus}`,
    };
  }

  const rule = await resolveCarrierRoutingRuleForOrderLeg({
    companyId,
    orderId: args.orderId,
    legId: args.legId,
  });
  if (!rule) {
    return { matched: false, booked: false, skippedReason: "no active carrier routing rule matched" };
  }

  const ruleSummary = {
    id: rule.id,
    name: rule.name,
    providerId: rule.providerId,
    providerCode: rule.providerCode,
  };

  if (!rule.autoBook) {
    return {
      matched: true,
      booked: false,
      skippedReason: "matched rule has autoBook disabled",
      rule: ruleSummary,
    };
  }

  const booking = await bookCarrierForOrderLeg({
    orderId: args.orderId,
    legId: args.legId,
    providerId: rule.providerId,
    actor,
  });

  return {
    matched: true,
    booked: true,
    rule: ruleSummary,
    booking,
  };
}

export async function autoBookCarrierForOrder(args: {
  orderId: string;
  actor?: (Actor & { companyId?: string | null }) | null;
}) {
  const legs = await db.orderLeg.findMany({
    where: { orderId: args.orderId },
    orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
    select: { id: true },
  });

  const results: AutoBookCarrierForOrderLegResult[] = [];
  for (const leg of legs) {
    results.push(
      await autoBookCarrierForOrderLeg({
        orderId: args.orderId,
        legId: leg.id,
        actor: args.actor,
      }),
    );
  }
  return results;
}
