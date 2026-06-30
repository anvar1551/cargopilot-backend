import { randomUUID } from "crypto";
import { PaymentType, TransportMode } from "@prisma/client";
import { createOrder, getOrderById } from "../repo";
import {
  CreateOrderRepoPayload,
  mapCreateOrderDtoToRepoPayload,
} from "../domain/orderCreate.mapper";
import { requireOrderActor } from "../shared";
import {
  createPaymentIntentForActor,
  isCompanyOnlinePaymentsAllowed,
} from "../../payments-core/application/paymentsService";
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
  resolvePayableTotalFromPricing,
  seedInitialServiceChargePricing,
} from "../../orders-legs";
import { quoteTariff } from "../../pricing-core";
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

function majorToMinor(amountMajor: number): bigint {
  return BigInt(Math.round(amountMajor * 100));
}

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
  payload: CreateOrderRepoPayload,
  companyId?: string | null,
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

  if (!originQuery || !destinationQuery || !weightKg || weightKg <= 0) {
    return {
      main: { quoteAvailable: false, reason: "missing_required_fields" },
      perLegRuleAmountsMajor: null,
    };
  }

  const mainQuote = (await quoteTariff({
    companyId: companyId ?? null,
    customerEntityId: payload.customerEntityId ?? null,
    serviceType,
    weightKg,
    originQuery,
    destinationQuery,
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
      quoteTariff({
        customerEntityId: payload.customerEntityId ?? null,
        companyId: companyId ?? null,
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

export async function createOrderForActor(args: CreateOrderForActorArgs) {
  const { user, body } = args;
  const paymentsEnabled = process.env.PAYMENTS_ENABLED === "true";
  const labelMode = resolveOrderLabelMode(process.env.ORDER_LABEL_MODE, "queue");
  const blockLabelWork = process.env.ORDER_LABEL_BLOCKING === "true";
  const autoLabelFallback = isOrderLabelAutoFallbackEnabled();

  if (!user?.id) {
    const err = new Error("Unauthorized") as Error & { statusCode: number };
    err.statusCode = 401;
    throw err;
  }
  const actor = requireOrderActor(user);
  const mapped = await mapCreateOrderDtoToRepoPayload(body);

  mapped.customerEntityId = mapped.customerEntityId ?? user.customerEntityId ?? null;
  const effectivePaymentType = mapped.paymentType ?? PaymentType.CASH;
  const requiresOnlineCheckout =
    effectivePaymentType === PaymentType.CARD ||
    effectivePaymentType === PaymentType.TRANSFER;

  const actorCompanyId = actor.companyId?.trim() || null;
  const ruleQuoteBundle = await computeRuleQuoteForOrder(mapped, actorCompanyId);
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

  const repoPayload = mapped as CreateOrderRepoPayload;
  const originCountryCode = resolveOriginCountryCode(mapped);
  const destinationCountryCode = resolveDestinationCountryCode(mapped);
  const linehaulMode = toOrderLegTransportMode(resolveTransportMode(mapped));
  const routeTemplateId =
    ruleQuoteBundle.main.quoteAvailable
      ? ruleQuoteBundle.main.tariffPlan?.routeTemplateId ?? null
      : null;
  const order = await createOrder(user.id, repoPayload, actor);
  let labelWarning: string | null = null;
  let pricingWarning: string | null = null;

  try {
    await seedInitialServiceChargePricing(
      order.id,
      {
        serviceCharge: mapped.serviceCharge ?? null,
        currency: mapped.currency ?? "UZS",
        serviceType: mapped.serviceType ?? null,
        perLegRuleAmountsMajor: ruleQuoteBundle.perLegRuleAmountsMajor,
        originCountryCode,
        destinationCountryCode,
        linehaulMode,
        routeTemplateId,
      },
      actor,
    );
  } catch (pricingErr: any) {
    pricingWarning = pricingErr?.message ?? "Failed to seed pricing components";
    console.error(`Pricing component seed failed for order ${order.id}:`, pricingErr);
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
  } catch (carrierRoutingErr: any) {
    carrierRoutingWarning =
      carrierRoutingErr?.message ?? "Carrier routing auto-book failed";
    console.error(`Carrier auto-book failed for order ${order.id}:`, carrierRoutingErr);
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
        await enqueueOrderLabelJob(order.id);
      } catch (queueErr) {
        if (!autoLabelFallback) throw queueErr;
        console.error(
          `Label enqueue failed for order ${order.id}, falling back to inline generation:`,
          queueErr,
        );
        await generateAndAttachParcelLabelsForOrder(order.id);
        return;
      }

      if (blockLabelWork && autoLabelFallback) {
        await runOrderLabelAutoFallback(order.id);
      } else if (autoLabelFallback) {
        scheduleOrderLabelAutoFallback(order.id);
      }
    } else {
      await generateAndAttachParcelLabelsForOrder(order.id);
    }
  };

  if (blockLabelWork) {
    try {
      await runLabelWork();
    } catch (labelErr: any) {
      labelWarning =
        labelErr?.message ??
        "Order created, but parcel label generation failed";
      console.error(`Label generation failed for order ${order.id}:`, labelErr);
      void createLabelFailureSupportTicket({
        orderId: order.id,
        reason: labelWarning,
      }).catch(() => undefined);
    }
  } else {
    void runLabelWork().catch((labelErr) => {
      console.error(`Label generation failed for order ${order.id}:`, labelErr);
      void createLabelFailureSupportTicket({
        orderId: order.id,
        reason: labelErr?.message ?? "Order label generation failed",
      }).catch(() => undefined);
    });
  }

  const companyId = actorCompanyId ?? "";
  const companyPaymentsAllowed = companyId
    ? await isCompanyOnlinePaymentsAllowed(companyId)
    : false;

  if (!paymentsEnabled || !requiresOnlineCheckout || !companyPaymentsAllowed) {
    return {
      statusCode: 201,
      payload: {
        order,
        warning: labelWarning ?? pricingWarning ?? carrierRoutingWarning,
        message:
          blockLabelWork
            ? labelWarning
              ? "Order created (manual payment) + parcel labels pending retry"
              : "Order created (manual payment) + parcel labels generated"
            : labelMode === "async" || labelMode === "sync"
              ? "Order created (manual payment) + parcel labels scheduled"
              : labelMode === "queue"
                ? "Order created (manual payment) + parcel labels queued"
                : "Order created (manual payment)",
      },
    };
  }

  const payableFromComponents = await resolvePayableTotalFromPricing(order.id).catch((err) => {
    console.error(`Pricing aggregation failed for order ${order.id}:`, err);
    return null;
  });

  const amountMajor = payableFromComponents?.amountMajor ?? null;
  const paymentCurrency = payableFromComponents?.currency ?? null;

  if (!payableFromComponents || amountMajor == null || amountMajor <= 0 || !paymentCurrency) {
    const err = new Error(
      "No payable pricing components found for online payment",
    ) as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }

  if (!companyId) {
    const err = new Error(
      "companyId is required for online payment flow",
    ) as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }

  const paymentIntent = await createPaymentIntentForActor({
    user,
    input: {
      companyId,
      orderId: order.id,
      amountMinor: majorToMinor(amountMajor),
      currency: paymentCurrency,
      provider: mapped.paymentProvider ?? undefined,
      idempotencyKey: mapped.paymentIntentIdempotencyKey ?? randomUUID(),
    },
  });

  const fresh = await getOrderById(order.id);
  return {
    statusCode: 201,
    payload: {
      order: fresh,
      paymentIntent,
      paymentUrl: paymentIntent.checkoutUrl ?? null,
      warning: labelWarning ?? pricingWarning ?? carrierRoutingWarning,
      message:
        blockLabelWork
          ? labelWarning
            ? "Order + payment intent created (parcel labels pending retry)"
            : "Order + parcel labels + payment intent created successfully"
          : labelMode === "async" || labelMode === "sync"
            ? "Order + payment intent created (parcel labels scheduled)"
            : labelMode === "queue"
              ? "Order + payment intent created (parcel labels queued)"
              : "Order + payment intent created successfully",
    },
  };
}
