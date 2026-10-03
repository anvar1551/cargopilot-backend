import { validateCreationReferences } from "../domain/creation-references";
import prisma from "../../../config/prismaClient";
import { requireTenantBoundOrderCompanyAuthority, hasCompanyScope } from "../domain/company-authority";
import { authorityError } from "../domain/creation-authority";
import { PaymentType, TransportMode } from "@prisma/client";
import { createOrder, getOrderCreationRetry } from "../repo/order-write.repo";
import { buildCreationRequest } from "../domain/creation-request";
import {
  CreateOrderRepoPayload,
  mapCreateOrderDtoToRepoPayload,
} from "../domain/orderCreate.mapper";
import { requireOrderActor } from "../shared";
import {
  enqueueOrderLabelJob,
  generateAndAttachParcelLabelsForOrder,
  isOrderLabelAutoFallbackEnabled,
  resolveOrderLabelMode,
  runOrderLabelAutoFallback,
  scheduleOrderLabelAutoFallback,
} from "../label";
import {
  autoBookCarrierForOrder,
  seedInitialServiceChargePricing,
} from "../../orders-legs";
import { quoteTariffForOrder } from "../../pricing-core";
import {
  normalizeCountryCode,
  TARIFF_TRANSPORT_MODES,
} from "../../pricing-core/shared/validation";
import type { AppUser } from "../../../types/app-user";
import {
  createLabelFailureSupportTicket,
  createSystemSupportTicket,
} from "../../support-core/application/autoTriage";

type TariffTransportMode = (typeof TARIFF_TRANSPORT_MODES)[number];

type RuleQuoteResult =
  | {
      quoteAvailable: true;
      currency: string;
      serviceCharge: number;
      tariffPlan?: {
        pricingStrategy?: string | null;
        routeTemplateId?: string | null;
      } | null;
      legBreakdown?: Array<{
        charge?: number | null;
      }> | null;
    }
  | {
      quoteAvailable: false;
      reason?: string | null;
    };

type CreateOrderForActorArgs = {
  user: AppUser | undefined;
  body: unknown;
};


function resolveOriginQuery(payload: CreateOrderRepoPayload): string | null {
  const fromSnapshot = payload.senderAddressSnapshot?.city;
  if (typeof fromSnapshot === "string" && fromSnapshot.trim()) return fromSnapshot.trim();
  return null;
}

function resolveDestinationQuery(payload: CreateOrderRepoPayload): string | null {
  const fromDestinationCity = payload.destinationCity;
  if (typeof fromDestinationCity === "string" && fromDestinationCity.trim()) {
    return fromDestinationCity.trim();
  }
  const fromSnapshot = payload.receiverAddressSnapshot?.city;
  if (typeof fromSnapshot === "string" && fromSnapshot.trim()) return fromSnapshot.trim();
  return null;
}

function resolveOriginCountryCode(payload: CreateOrderRepoPayload): string | null {
  const fromSnapshot = payload.senderAddressSnapshot?.country;
  if (typeof fromSnapshot === "string" && fromSnapshot.trim()) {
    return normalizeCountryCode(fromSnapshot);
  }
  return null;
}

function resolveDestinationCountryCode(payload: CreateOrderRepoPayload): string | null {
  const fromSnapshot = payload.receiverAddressSnapshot?.country;
  if (typeof fromSnapshot === "string" && fromSnapshot.trim()) {
    return normalizeCountryCode(fromSnapshot);
  }
  return null;
}

function resolveTransportMode(
  payload: CreateOrderRepoPayload,
): TariffTransportMode {
  const normalized = payload.transportMode?.trim().toUpperCase() || "ROAD";
  return TARIFF_TRANSPORT_MODES.includes(normalized as TariffTransportMode)
    ? (normalized as TariffTransportMode)
    : "ROAD";
}

function toOrderLegTransportMode(value: TariffTransportMode): TransportMode {
  if (value === "AIR") return TransportMode.air;
  if (value === "SEA") return TransportMode.sea;
  if (value === "RAIL") return TransportMode.rail;
  if (value === "MULTIMODAL") return TransportMode.multimodal;
  return TransportMode.road;
}

function buildLegQuoteQueries(
  serviceType: CreateOrderRepoPayload["serviceType"],
  originQuery: string,
  destinationQuery: string,
) {
  if (serviceType === "DOOR_TO_POINT") {
    return [
      { originQuery, destinationQuery: originQuery },
      { originQuery, destinationQuery },
    ];
  }
  if (serviceType === "POINT_TO_DOOR") {
    return [
      { originQuery, destinationQuery },
      { originQuery: destinationQuery, destinationQuery },
    ];
  }
  if (serviceType === "POINT_TO_POINT") {
    return [{ originQuery, destinationQuery }];
  }
  return [
    { originQuery, destinationQuery: originQuery },
    { originQuery, destinationQuery },
    { originQuery: destinationQuery, destinationQuery },
  ];
}

async function computeRuleQuoteForOrder(
  context: AppUser,
  payload: CreateOrderRepoPayload,
): Promise<{
  main: RuleQuoteResult;
  perLegRuleAmountsMajor: number[] | null;
}> {
  const originQuery = resolveOriginQuery(payload);
  const destinationQuery = resolveDestinationQuery(payload);
  const originCountryCode = resolveOriginCountryCode(payload);
  const destinationCountryCode = resolveDestinationCountryCode(payload);
  const transportMode = resolveTransportMode(payload);
  const weightKg = typeof payload.weightKg === "number" ? payload.weightKg : null;
  const serviceType = payload.serviceType ?? "DOOR_TO_DOOR";

  const mainQuote = (await quoteTariffForOrder(context, {
    customerEntityId: payload.customerEntityId ?? null,
    serviceType,
    weightKg: weightKg && weightKg > 0 ? weightKg : null,
    originQuery: originQuery ?? "",
    destinationQuery: destinationQuery ?? "",
    originCountryCode,
    destinationCountryCode,
    transportMode,
  })) as RuleQuoteResult;

  if (!mainQuote.quoteAvailable) {
    return {
      main: mainQuote,
      perLegRuleAmountsMajor: null,
    };
  }
  if (!originQuery || !destinationQuery || !weightKg || weightKg <= 0) {
    return {
      main: { quoteAvailable: false, reason: "missing_required_fields" },
      perLegRuleAmountsMajor: null,
    };
  }

  const pricingStrategy = mainQuote.tariffPlan?.pricingStrategy ?? null;
  if (pricingStrategy === "LEG_TRANSIT" && Array.isArray(mainQuote.legBreakdown)) {
    const fromBreakdown = mainQuote.legBreakdown
      .map((leg) => Number(leg.charge ?? 0))
      .filter((amount) => Number.isFinite(amount) && amount > 0);

    return {
      main: mainQuote,
      perLegRuleAmountsMajor: fromBreakdown.length > 0 ? fromBreakdown : null,
    };
  }

  const legQueries = buildLegQuoteQueries(serviceType, originQuery, destinationQuery);
  const legQuotes = await Promise.all(
    legQueries.map((legQuery) =>
      quoteTariffForOrder(context, {
        customerEntityId: payload.customerEntityId ?? null,
        serviceType,
        weightKg,
        originQuery: legQuery.originQuery,
        destinationQuery: legQuery.destinationQuery,
        originCountryCode,
        destinationCountryCode,
        transportMode,
      }) as Promise<RuleQuoteResult>,
    ),
  );

  const canUseLegQuotes =
    legQuotes.length === legQueries.length &&
    legQuotes.every(
      (quote) =>
        quote.quoteAvailable &&
        quote.currency.trim().toUpperCase() === mainQuote.currency.trim().toUpperCase() &&
        Number.isFinite(quote.serviceCharge) &&
        quote.serviceCharge > 0,
    );

  return {
    main: mainQuote,
    perLegRuleAmountsMajor: canUseLegQuotes
      ? legQuotes.map((quote) => (quote as { serviceCharge: number }).serviceCharge)
      : null,
  };
}

export async function prepareAuthorizedOrderCreation(
  user: AppUser | undefined,
  mapped: CreateOrderRepoPayload,
) {
  if (!user?.id) {
    const err = new Error("Unauthorized") as Error & { statusCode: number };
    err.statusCode = 401;
    throw err;
  }
  const actor = requireOrderActor(user);
  const membership = await requireTenantBoundOrderCompanyAuthority(prisma, actor, "shipment.create");
  if (!hasCompanyScope(membership)) throw authorityError("Company creation scope required", 403);

  await validateCreationReferences(prisma, user, mapped, false);
  const effectivePaymentType = mapped.paymentType ?? PaymentType.CASH;
  const requiresOnlineCheckout =
    effectivePaymentType === PaymentType.CARD ||
    effectivePaymentType === PaymentType.TRANSFER;
  const ruleQuoteBundle = await computeRuleQuoteForOrder(user, mapped);
  if (ruleQuoteBundle.main.quoteAvailable) {
    mapped.serviceCharge = ruleQuoteBundle.main.serviceCharge;
    mapped.currency = ruleQuoteBundle.main.currency;
  }
  if (requiresOnlineCheckout && !ruleQuoteBundle.main.quoteAvailable) {
    const err = new Error(
      `Online payment requires active pricing rule quote (${ruleQuoteBundle.main.reason ?? "quote_unavailable"})`,
    ) as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }

  const originCountryCode = resolveOriginCountryCode(mapped);
  const destinationCountryCode = resolveDestinationCountryCode(mapped);
  const linehaulMode = toOrderLegTransportMode(resolveTransportMode(mapped));
  const routeTemplateId =
    ruleQuoteBundle.main.quoteAvailable
      ? ruleQuoteBundle.main.tariffPlan?.routeTemplateId ?? null
      : null;

  return {
    actor,
    payload: mapped,
    requiresOnlineCheckout,
    pricingSeed: {
      serviceCharge: mapped.serviceCharge ?? null,
      currency: mapped.currency ?? "UZS",
      serviceType: mapped.serviceType ?? null,
      perLegRuleAmountsMajor: ruleQuoteBundle.perLegRuleAmountsMajor,
      originCountryCode,
      destinationCountryCode,
      linehaulMode,
      routeTemplateId,
    },
  };
}

export async function createOrderForActor(args: CreateOrderForActorArgs) {
  const { user, body } = args;
  const labelMode = resolveOrderLabelMode(process.env.ORDER_LABEL_MODE, "queue");
  const blockLabelWork = process.env.ORDER_LABEL_BLOCKING === "true";
  const autoLabelFallback = isOrderLabelAutoFallbackEnabled();

  const mapped = await mapCreateOrderDtoToRepoPayload(body);
  const requestedActor = requireOrderActor(user);
  const request = buildCreationRequest(requestedActor, (body as any)?.operationId, "order", [mapped]);
  const prior = await getOrderCreationRetry(requestedActor, request);
  if (prior) return creationReplay(prior);
  const prepared = await prepareAuthorizedOrderCreation(user, mapped);
  const { actor, requiresOnlineCheckout } = prepared;
  const created = await createOrder(user!.id, prepared.payload, actor, request);
  if (created.replayed) return creationReplay(created.order);
  const order = created.order;
  let labelWarning: string | null = null;
  let pricingWarning: string | null = null;

  try {
    await seedInitialServiceChargePricing(
      order.id,
      prepared.pricingSeed,
      actor,
    );
  } catch {
    pricingWarning = "Failed to seed pricing components";
    console.error("ORDER_PRICING_SEED_FAILED", { orderId: order.id });
  }

  let carrierRoutingWarning: string | null = null;
  try {
    const autoBookResults = await autoBookCarrierForOrder({
      orderId: order.id,
      actor,
    });
    const failedMatches = autoBookResults.filter(
      (item) => item.matched && !item.booked && item.skippedReason !== "matched rule has autoBook disabled",
    );
    if (failedMatches.length > 0) {
      carrierRoutingWarning = "Carrier routing matched but auto-booking was not completed for every leg";
      void createSystemSupportTicket({
        sourceKey: `carrier:auto-book:${order.id}:partial:v1`,
        orderId: order.id,
        title: "Carrier auto-booking did not complete",
        summary: `${failedMatches.length} carrier routing match(es) did not complete during order creation.`,
        routingKey: "carrier",
      }).catch(() => undefined);
    }
  } catch {
    carrierRoutingWarning =
      "Carrier routing auto-book failed";
    console.error("ORDER_CARRIER_AUTOBOOK_FAILED", { orderId: order.id });
    void createSystemSupportTicket({
      sourceKey: `carrier:auto-book:${order.id}:failed:v1`,
      orderId: order.id,
      title: "Carrier auto-booking failed",
      summary: carrierRoutingWarning,
      routingKey: "carrier",
    }).catch(() => undefined);
  }

  const runLabelWork = async () => {
    if (labelMode === "queue") {
      try {
        await enqueueOrderLabelJob(order.id, actor);
      } catch (queueErr) {
        if (!autoLabelFallback) throw queueErr;
        console.error(
          "ORDER_LABEL_ENQUEUE_INLINE_FALLBACK",
          { orderId: order.id },
        );
        await generateAndAttachParcelLabelsForOrder(order.id, actor);
        return;
      }

      if (blockLabelWork && autoLabelFallback) {
        await runOrderLabelAutoFallback(order.id, actor);
      } else if (autoLabelFallback) {
        await scheduleOrderLabelAutoFallback(order.id, actor);
      }
    } else {
      await generateAndAttachParcelLabelsForOrder(order.id, actor);
    }
  };

  if (blockLabelWork) {
    try {
      await runLabelWork();
    } catch {
      labelWarning =
        "Order created, but parcel label generation failed";
      console.error("ORDER_LABEL_GENERATION_FAILED", { orderId: order.id });
      void createLabelFailureSupportTicket({
        orderId: order.id,
        reason: labelWarning,
      }).catch(() => undefined);
    }
  } else {
    void runLabelWork().catch(() => {
      console.error("ORDER_LABEL_GENERATION_FAILED", { orderId: order.id });
      void createLabelFailureSupportTicket({
        orderId: order.id,
        reason: "Order label generation failed",
      }).catch(() => undefined);
    });
  }

  // A new order has no issued invoice. Do not charge a mutable/Float quote.
  return {
    statusCode: 201,
    payload: {
      order,
      creationReplay: false,
      paymentUrl: null,
      paymentPendingInvoice: requiresOnlineCheckout,
      warning: labelWarning ?? pricingWarning ?? carrierRoutingWarning,
      message: requiresOnlineCheckout
        ? "Order created; issue an invoice before requesting online payment"
        : "Order created (manual payment)",
    },
  };
}


function creationReplay(order: any) {
  return {statusCode:201,payload:{order,paymentUrl:null,
    paymentPendingInvoice:!order.invoice && (order.paymentType===PaymentType.CARD || order.paymentType===PaymentType.TRANSFER),
    warning:null,creationReplay:true,downstreamRecoveryRequired:true,
    message:"Order already confirmed; downstream work is not replayed"}};
}
