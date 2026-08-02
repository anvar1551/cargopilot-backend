"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOrderForActor = createOrderForActor;
const crypto_1 = require("crypto");
const client_1 = require("@prisma/client");
const repo_1 = require("../repo");
const orderCreate_mapper_1 = require("../domain/orderCreate.mapper");
const shared_1 = require("../shared");
const paymentsService_1 = require("../../payments-core/application/paymentsService");
const label_1 = require("../label");
const orders_legs_1 = require("../../orders-legs");
const pricing_core_1 = require("../../pricing-core");
const validation_1 = require("../../pricing-core/shared/validation");
const autoTriage_1 = require("../../support-core/application/autoTriage");
function majorToMinor(amountMajor) {
    return BigInt(Math.round(amountMajor * 100));
}
function resolveOriginQuery(payload) {
    const fromSnapshot = payload.senderAddressSnapshot?.city;
    if (typeof fromSnapshot === "string" && fromSnapshot.trim())
        return fromSnapshot.trim();
    return null;
}
function resolveDestinationQuery(payload) {
    const fromDestinationCity = payload.destinationCity;
    if (typeof fromDestinationCity === "string" && fromDestinationCity.trim()) {
        return fromDestinationCity.trim();
    }
    const fromSnapshot = payload.receiverAddressSnapshot?.city;
    if (typeof fromSnapshot === "string" && fromSnapshot.trim())
        return fromSnapshot.trim();
    return null;
}
function resolveOriginCountryCode(payload) {
    const fromSnapshot = payload.senderAddressSnapshot?.country;
    if (typeof fromSnapshot === "string" && fromSnapshot.trim()) {
        return (0, validation_1.normalizeCountryCode)(fromSnapshot);
    }
    return null;
}
function resolveDestinationCountryCode(payload) {
    const fromSnapshot = payload.receiverAddressSnapshot?.country;
    if (typeof fromSnapshot === "string" && fromSnapshot.trim()) {
        return (0, validation_1.normalizeCountryCode)(fromSnapshot);
    }
    return null;
}
function resolveTransportMode(payload) {
    const normalized = payload.transportMode?.trim().toUpperCase() || "ROAD";
    return validation_1.TARIFF_TRANSPORT_MODES.includes(normalized)
        ? normalized
        : "ROAD";
}
function toOrderLegTransportMode(value) {
    if (value === "AIR")
        return client_1.TransportMode.air;
    if (value === "SEA")
        return client_1.TransportMode.sea;
    if (value === "RAIL")
        return client_1.TransportMode.rail;
    if (value === "MULTIMODAL")
        return client_1.TransportMode.multimodal;
    return client_1.TransportMode.road;
}
function buildLegQuoteQueries(serviceType, originQuery, destinationQuery) {
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
async function computeRuleQuoteForOrder(payload, companyId) {
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
    const mainQuote = (await (0, pricing_core_1.quoteTariff)({
        companyId: companyId ?? null,
        customerEntityId: payload.customerEntityId ?? null,
        serviceType,
        weightKg,
        originQuery,
        destinationQuery,
        originCountryCode,
        destinationCountryCode,
        transportMode,
    }));
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
    const legQuotes = await Promise.all(legQueries.map((legQuery) => (0, pricing_core_1.quoteTariff)({
        customerEntityId: payload.customerEntityId ?? null,
        companyId: companyId ?? null,
        serviceType,
        weightKg,
        originQuery: legQuery.originQuery,
        destinationQuery: legQuery.destinationQuery,
        originCountryCode,
        destinationCountryCode,
        transportMode,
    })));
    const canUseLegQuotes = legQuotes.length === legQueries.length &&
        legQuotes.every((quote) => quote.quoteAvailable &&
            quote.currency.trim().toUpperCase() === mainQuote.currency.trim().toUpperCase() &&
            Number.isFinite(quote.serviceCharge) &&
            quote.serviceCharge > 0);
    return {
        main: mainQuote,
        perLegRuleAmountsMajor: canUseLegQuotes
            ? legQuotes.map((quote) => quote.serviceCharge)
            : null,
    };
}
async function createOrderForActor(args) {
    const { user, body } = args;
    const paymentsEnabled = process.env.PAYMENTS_ENABLED === "true";
    const labelMode = (0, label_1.resolveOrderLabelMode)(process.env.ORDER_LABEL_MODE, "queue");
    const blockLabelWork = process.env.ORDER_LABEL_BLOCKING === "true";
    const autoLabelFallback = (0, label_1.isOrderLabelAutoFallbackEnabled)();
    if (!user?.id) {
        const err = new Error("Unauthorized");
        err.statusCode = 401;
        throw err;
    }
    const actor = (0, shared_1.requireOrderActor)(user);
    const mapped = await (0, orderCreate_mapper_1.mapCreateOrderDtoToRepoPayload)(body);
    mapped.customerEntityId = mapped.customerEntityId ?? user.customerEntityId ?? null;
    const effectivePaymentType = mapped.paymentType ?? client_1.PaymentType.CASH;
    const requiresOnlineCheckout = effectivePaymentType === client_1.PaymentType.CARD ||
        effectivePaymentType === client_1.PaymentType.TRANSFER;
    const actorCompanyId = actor.companyId?.trim() || null;
    const ruleQuoteBundle = await computeRuleQuoteForOrder(mapped, actorCompanyId);
    if (ruleQuoteBundle.main.quoteAvailable) {
        mapped.serviceCharge = ruleQuoteBundle.main.serviceCharge;
        mapped.currency = ruleQuoteBundle.main.currency;
    }
    if (requiresOnlineCheckout && !ruleQuoteBundle.main.quoteAvailable) {
        const err = new Error(`Online payment requires active pricing rule quote (${ruleQuoteBundle.main.reason ?? "quote_unavailable"})`);
        err.statusCode = 400;
        throw err;
    }
    const repoPayload = mapped;
    const originCountryCode = resolveOriginCountryCode(mapped);
    const destinationCountryCode = resolveDestinationCountryCode(mapped);
    const linehaulMode = toOrderLegTransportMode(resolveTransportMode(mapped));
    const routeTemplateId = ruleQuoteBundle.main.quoteAvailable
        ? ruleQuoteBundle.main.tariffPlan?.routeTemplateId ?? null
        : null;
    const order = await (0, repo_1.createOrder)(user.id, repoPayload, actor);
    let labelWarning = null;
    let pricingWarning = null;
    try {
        await (0, orders_legs_1.seedInitialServiceChargePricing)(order.id, {
            serviceCharge: mapped.serviceCharge ?? null,
            currency: mapped.currency ?? "UZS",
            serviceType: mapped.serviceType ?? null,
            perLegRuleAmountsMajor: ruleQuoteBundle.perLegRuleAmountsMajor,
            originCountryCode,
            destinationCountryCode,
            linehaulMode,
            routeTemplateId,
        }, actor);
    }
    catch (pricingErr) {
        pricingWarning = pricingErr?.message ?? "Failed to seed pricing components";
        console.error(`Pricing component seed failed for order ${order.id}:`, pricingErr);
    }
    let carrierRoutingWarning = null;
    try {
        const autoBookResults = await (0, orders_legs_1.autoBookCarrierForOrder)({
            orderId: order.id,
            actor,
        });
        const failedMatches = autoBookResults.filter((item) => item.matched && !item.booked && item.skippedReason !== "matched rule has autoBook disabled");
        if (failedMatches.length > 0) {
            carrierRoutingWarning = "Carrier routing matched but auto-booking was not completed for every leg";
            void (0, autoTriage_1.createSystemSupportTicket)({
                sourceKey: `carrier:auto-book:${order.id}:partial:v1`,
                orderId: order.id,
                title: "Carrier auto-booking did not complete",
                summary: `${failedMatches.length} carrier routing match(es) did not complete during order creation.`,
                routingKey: "carrier",
            }).catch(() => undefined);
        }
    }
    catch (carrierRoutingErr) {
        carrierRoutingWarning =
            carrierRoutingErr?.message ?? "Carrier routing auto-book failed";
        console.error(`Carrier auto-book failed for order ${order.id}:`, carrierRoutingErr);
        void (0, autoTriage_1.createSystemSupportTicket)({
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
                await (0, label_1.enqueueOrderLabelJob)(order.id);
            }
            catch (queueErr) {
                if (!autoLabelFallback)
                    throw queueErr;
                console.error(`Label enqueue failed for order ${order.id}, falling back to inline generation:`, queueErr);
                await (0, label_1.generateAndAttachParcelLabelsForOrder)(order.id);
                return;
            }
            if (blockLabelWork && autoLabelFallback) {
                await (0, label_1.runOrderLabelAutoFallback)(order.id);
            }
            else if (autoLabelFallback) {
                (0, label_1.scheduleOrderLabelAutoFallback)(order.id);
            }
        }
        else {
            await (0, label_1.generateAndAttachParcelLabelsForOrder)(order.id);
        }
    };
    if (blockLabelWork) {
        try {
            await runLabelWork();
        }
        catch (labelErr) {
            labelWarning =
                labelErr?.message ??
                    "Order created, but parcel label generation failed";
            console.error(`Label generation failed for order ${order.id}:`, labelErr);
            void (0, autoTriage_1.createLabelFailureSupportTicket)({
                orderId: order.id,
                reason: labelWarning,
            }).catch(() => undefined);
        }
    }
    else {
        void runLabelWork().catch((labelErr) => {
            console.error(`Label generation failed for order ${order.id}:`, labelErr);
            void (0, autoTriage_1.createLabelFailureSupportTicket)({
                orderId: order.id,
                reason: labelErr?.message ?? "Order label generation failed",
            }).catch(() => undefined);
        });
    }
    const companyId = actorCompanyId ?? "";
    const companyPaymentsAllowed = companyId
        ? await (0, paymentsService_1.isCompanyOnlinePaymentsAllowed)(companyId)
        : false;
    if (!paymentsEnabled || !requiresOnlineCheckout || !companyPaymentsAllowed) {
        return {
            statusCode: 201,
            payload: {
                order,
                warning: labelWarning ?? pricingWarning ?? carrierRoutingWarning,
                message: blockLabelWork
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
    const payableFromComponents = await (0, orders_legs_1.resolvePayableTotalFromPricing)(order.id).catch((err) => {
        console.error(`Pricing aggregation failed for order ${order.id}:`, err);
        return null;
    });
    const amountMajor = payableFromComponents?.amountMajor ?? null;
    const paymentCurrency = payableFromComponents?.currency ?? null;
    if (!payableFromComponents || amountMajor == null || amountMajor <= 0 || !paymentCurrency) {
        const err = new Error("No payable pricing components found for online payment");
        err.statusCode = 400;
        throw err;
    }
    if (!companyId) {
        const err = new Error("companyId is required for online payment flow");
        err.statusCode = 400;
        throw err;
    }
    const paymentIntent = await (0, paymentsService_1.createPaymentIntentForActor)({
        user,
        input: {
            companyId,
            orderId: order.id,
            amountMinor: majorToMinor(amountMajor),
            currency: paymentCurrency,
            provider: mapped.paymentProvider ?? undefined,
            idempotencyKey: mapped.paymentIntentIdempotencyKey ?? (0, crypto_1.randomUUID)(),
        },
    });
    const fresh = await (0, repo_1.getOrderById)(order.id);
    return {
        statusCode: 201,
        payload: {
            order: fresh,
            paymentIntent,
            paymentUrl: paymentIntent.checkoutUrl ?? null,
            warning: labelWarning ?? pricingWarning ?? carrierRoutingWarning,
            message: blockLabelWork
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
