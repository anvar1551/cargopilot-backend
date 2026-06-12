"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HttpSmsAdapter = exports.HttpCarrierAdapter = void 0;
exports.toCarrierCreateShipmentInput = toCarrierCreateShipmentInput;
exports.toSmsSendInput = toSmsSendInput;
exports.toCarrierTrackInput = toCarrierTrackInput;
exports.toCarrierCancelInput = toCarrierCancelInput;
exports.toSmsStatusInput = toSmsStatusInput;
exports.normalizeProviderCode = normalizeProviderCode;
exports.isProviderEnvFallbackEnabled = isProviderEnvFallbackEnabled;
exports.resolveProviderHttpConfig = resolveProviderHttpConfig;
const integration_http_client_1 = require("./integration-http-client");
function toObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    return value;
}
function pickString(source, keys) {
    const object = toObject(source);
    if (!object)
        return null;
    for (const key of keys) {
        const value = object[key];
        if (typeof value === "string" && value.trim())
            return value.trim();
        if (typeof value === "number" || typeof value === "bigint")
            return String(value);
    }
    return null;
}
function mapHttpResult(args) {
    const retryable = args.response.statusCode === 429 || args.response.statusCode >= 500;
    const ok = args.response.statusCode >= 200 && args.response.statusCode < 300;
    return {
        ok,
        retryable,
        providerStatusCode: args.response.statusCode,
        data: ok ? args.data : undefined,
        message: ok ? undefined : `Provider responded with ${args.response.statusCode}`,
    };
}
function buildHeaders(config, context) {
    const headers = {
        "content-type": "application/json",
        "x-cargopilot-request-id": context.requestId,
        "x-cargopilot-company-id": context.companyId,
    };
    if (context.idempotencyKey) {
        headers["x-idempotency-key"] = context.idempotencyKey;
    }
    if (config.token) {
        headers.authorization = `Bearer ${config.token}`;
    }
    if (config.apiKey) {
        const headerName = config.apiKeyHeader?.trim().toLowerCase() || "x-api-key";
        headers[headerName] = config.apiKey;
    }
    return headers;
}
async function requestJson(args) {
    const url = new URL(args.path, args.config.baseUrl);
    const response = await (0, integration_http_client_1.integrationHttpJson)({
        url: url.toString(),
        method: args.method,
        headers: buildHeaders(args.config, args.context),
        body: args.body,
        timeoutMs: args.config.timeoutMs,
    });
    return {
        statusCode: response.statusCode,
        body: response.body,
    };
}
function normalizeParcels(value) {
    if (!Array.isArray(value))
        return [];
    return value
        .map((item) => {
        const row = toObject(item);
        if (!row)
            return null;
        const weightRaw = row.weightKg;
        const weightKg = typeof weightRaw === "number"
            ? weightRaw
            : typeof weightRaw === "string"
                ? Number(weightRaw)
                : NaN;
        if (!Number.isFinite(weightKg) || weightKg <= 0)
            return null;
        const quantityValue = typeof row.quantity === "number"
            ? row.quantity
            : typeof row.quantity === "string"
                ? Number(row.quantity)
                : undefined;
        const descriptionValue = typeof row.description === "string" ? row.description : undefined;
        const normalized = {
            weightKg,
            ...(Number.isFinite(quantityValue) ? { quantity: quantityValue } : {}),
            ...(descriptionValue ? { description: descriptionValue } : {}),
        };
        return normalized;
    })
        .filter((item) => item !== null);
}
function normalizeDeclaredValueMinor(value) {
    if (typeof value === "bigint")
        return value;
    if (typeof value === "number" && Number.isFinite(value))
        return BigInt(Math.trunc(value));
    if (typeof value === "string" && value.trim()) {
        try {
            return BigInt(value.trim());
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}
class HttpCarrierAdapter {
    constructor(config) {
        this.supportedModes = [
            "road",
            "air",
            "rail",
            "sea",
            "multimodal",
        ];
        this.providerCode = config.providerCode;
        this.config = config;
    }
    async createShipment(input, context) {
        const response = await requestJson({
            config: this.config,
            method: "POST",
            path: "/shipments",
            context,
            body: {
                externalOrderId: input.externalOrderId,
                sender: input.sender,
                receiver: input.receiver,
                parcels: input.parcels,
                declaredValueMinor: input.declaredValueMinor?.toString(),
                currency: input.currency,
                transportMode: input.transportMode,
                serviceCode: input.serviceCode,
                metadata: input.metadata,
            },
        });
        const responseBody = toObject(response.body);
        const partnerShipmentId = pickString(responseBody, [
            "partnerShipmentId",
            "shipmentId",
            "id",
        ]);
        const trackingNumber = pickString(responseBody, ["trackingNumber", "awb", "trackingNo"]);
        const labelUrl = pickString(responseBody, ["labelUrl", "labelURL"]);
        const mapped = mapHttpResult({
            response,
            data: partnerShipmentId
                ? {
                    partnerShipmentId,
                    trackingNumber: trackingNumber ?? undefined,
                    labelUrl: labelUrl ?? undefined,
                    rawResponse: responseBody ?? undefined,
                }
                : undefined,
        });
        if (mapped.ok && !mapped.data?.partnerShipmentId) {
            return {
                ok: false,
                retryable: false,
                providerStatusCode: response.statusCode,
                message: "Carrier response is missing partnerShipmentId",
            };
        }
        return mapped;
    }
    async cancelShipment(input, context) {
        const response = await requestJson({
            config: this.config,
            method: "POST",
            path: `/shipments/${encodeURIComponent(input.partnerShipmentId)}/cancel`,
            context,
            body: {
                reason: input.reason,
            },
        });
        return mapHttpResult({
            response,
            data: {},
        });
    }
    async track(input, context) {
        const path = input.partnerShipmentId
            ? `/shipments/${encodeURIComponent(input.partnerShipmentId)}/track`
            : `/shipments/track?trackingNumber=${encodeURIComponent(input.trackingNumber || "")}`;
        const response = await requestJson({
            config: this.config,
            method: "GET",
            path,
            context,
        });
        const responseBody = toObject(response.body);
        return mapHttpResult({
            response,
            data: {
                statusCode: pickString(responseBody, ["statusCode", "status", "code"]) || "unknown",
                statusLabel: pickString(responseBody, ["statusLabel", "statusText", "label"]) || "Unknown",
                happenedAt: pickString(responseBody, ["happenedAt", "updatedAt", "timestamp"]) || undefined,
                location: pickString(responseBody, ["location", "city", "place"]) || undefined,
                rawResponse: responseBody ?? undefined,
            },
        });
    }
}
exports.HttpCarrierAdapter = HttpCarrierAdapter;
class HttpSmsAdapter {
    constructor(config) {
        this.providerCode = config.providerCode;
        this.config = config;
    }
    async send(input, context) {
        const response = await requestJson({
            config: this.config,
            method: "POST",
            path: "/messages",
            context,
            body: {
                to: input.to,
                text: input.text,
                templateCode: input.templateCode,
                metadata: input.metadata,
            },
        });
        const responseBody = toObject(response.body);
        const messageId = pickString(responseBody, ["messageId", "id"]);
        const acceptedAt = pickString(responseBody, ["acceptedAt", "createdAt", "timestamp"]);
        const mapped = mapHttpResult({
            response,
            data: messageId
                ? {
                    messageId,
                    acceptedAt: acceptedAt ?? undefined,
                    rawResponse: responseBody ?? undefined,
                }
                : undefined,
        });
        if (mapped.ok && !mapped.data?.messageId) {
            return {
                ok: false,
                retryable: false,
                providerStatusCode: response.statusCode,
                message: "SMS provider response is missing messageId",
            };
        }
        return mapped;
    }
    async getDeliveryStatus(input, context) {
        const response = await requestJson({
            config: this.config,
            method: "GET",
            path: `/messages/${encodeURIComponent(input.messageId)}`,
            context,
        });
        const responseBody = toObject(response.body);
        return mapHttpResult({
            response,
            data: {
                status: pickString(responseBody, ["status", "deliveryStatus", "state"]) || "unknown",
                deliveredAt: pickString(responseBody, ["deliveredAt", "updatedAt", "timestamp"]) ?? undefined,
                rawResponse: responseBody ?? undefined,
            },
        });
    }
}
exports.HttpSmsAdapter = HttpSmsAdapter;
function normalizeAddressNode(value) {
    const object = toObject(value);
    if (!object)
        return null;
    const name = pickString(object, ["name", "fullName"]) || "";
    const phone = pickString(object, ["phone", "phoneNumber"]) || "";
    const address = pickString(object, ["address", "line1", "street"]) || "";
    const latRaw = object.lat;
    const lngRaw = object.lng;
    const lat = typeof latRaw === "number" ? latRaw : typeof latRaw === "string" ? Number(latRaw) : undefined;
    const lng = typeof lngRaw === "number" ? lngRaw : typeof lngRaw === "string" ? Number(lngRaw) : undefined;
    if (!name || !phone || !address)
        return null;
    return {
        name,
        phone,
        address,
        lat: Number.isFinite(lat) ? lat : undefined,
        lng: Number.isFinite(lng) ? lng : undefined,
    };
}
function normalizeCarrierMode(value) {
    if (typeof value !== "string")
        return undefined;
    const normalized = value.trim().toLowerCase();
    if (["road", "air", "rail", "sea", "multimodal"].includes(normalized)) {
        return normalized;
    }
    return undefined;
}
function toCarrierCreateShipmentInput(eventPayload, aggregateId) {
    const inputObject = toObject(eventPayload.input);
    const source = inputObject || eventPayload;
    const sender = normalizeAddressNode(source.sender) ||
        normalizeAddressNode(source.from) ||
        normalizeAddressNode(source.origin);
    const receiver = normalizeAddressNode(source.receiver) ||
        normalizeAddressNode(source.to) ||
        normalizeAddressNode(source.destination);
    const parcels = normalizeParcels(source.parcels || source.items);
    const externalOrderId = pickString(source, ["externalOrderId", "orderId", "shipmentId", "aggregateId"]) || aggregateId;
    if (!externalOrderId || !sender || !receiver || parcels.length === 0)
        return null;
    return {
        externalOrderId,
        sender,
        receiver,
        parcels,
        declaredValueMinor: normalizeDeclaredValueMinor(source.declaredValueMinor),
        currency: pickString(source, ["currency"]) || undefined,
        transportMode: normalizeCarrierMode(source.transportMode || source.mode),
        serviceCode: pickString(source, ["serviceCode", "service"]) || undefined,
        metadata: toObject(source.metadata || source.meta) || undefined,
    };
}
function toSmsSendInput(eventPayload) {
    const inputObject = toObject(eventPayload.input);
    const source = inputObject || eventPayload;
    const to = pickString(source, ["to", "phone", "recipient"]) || "";
    const text = pickString(source, ["text", "message", "body"]) || "";
    if (!to || !text)
        return null;
    return {
        to,
        text,
        templateCode: pickString(source, ["templateCode", "template"]) || undefined,
        metadata: toObject(source.metadata || source.meta) || undefined,
    };
}
function toCarrierTrackInput(eventPayload) {
    const inputObject = toObject(eventPayload.input);
    const source = inputObject || eventPayload;
    const partnerShipmentId = pickString(source, [
        "partnerShipmentId",
        "shipmentId",
        "carrierRef",
    ]);
    const trackingNumber = pickString(source, ["trackingNumber", "awb", "trackingNo"]);
    if (!partnerShipmentId && !trackingNumber)
        return null;
    return {
        partnerShipmentId: partnerShipmentId ?? undefined,
        trackingNumber: trackingNumber ?? undefined,
    };
}
function toCarrierCancelInput(eventPayload) {
    const inputObject = toObject(eventPayload.input);
    const source = inputObject || eventPayload;
    const partnerShipmentId = pickString(source, [
        "partnerShipmentId",
        "shipmentId",
        "carrierRef",
    ]);
    if (!partnerShipmentId)
        return null;
    return {
        partnerShipmentId,
        reason: pickString(source, ["reason", "cancelReason"]) || undefined,
    };
}
function toSmsStatusInput(eventPayload) {
    const inputObject = toObject(eventPayload.input);
    const source = inputObject || eventPayload;
    const messageId = pickString(source, ["messageId", "id"]);
    if (!messageId)
        return null;
    return { messageId };
}
function normalizeProviderCode(value) {
    return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "_");
}
function isProviderEnvFallbackEnabled() {
    const value = String(process.env.INTEGRATION_ALLOW_ENV_PROVIDER_FALLBACK || "")
        .trim()
        .toLowerCase();
    return value === "1" || value === "true" || value === "yes";
}
function readProviderEnvValue(key) {
    if (!isProviderEnvFallbackEnabled())
        return "";
    return String(process.env[key] || "").trim();
}
function resolveProviderHttpConfig(args) {
    const suffix = normalizeProviderCode(args.providerCode);
    const domainPrefix = args.domain === "carrier" ? "CARRIER" : "SMS";
    const baseUrl = String(args.secretConfig?.baseUrl || args.secretConfig?.endpointUrl || "").trim() ||
        readProviderEnvValue(`INTEGRATION_${domainPrefix}_BASE_URL_${suffix}`) ||
        readProviderEnvValue(`INTEGRATION_PROVIDER_BASE_URL_${suffix}`);
    if (!baseUrl)
        return null;
    const token = String(args.secretConfig?.token || "").trim() ||
        readProviderEnvValue(`INTEGRATION_${domainPrefix}_TOKEN_${suffix}`) ||
        readProviderEnvValue(`INTEGRATION_PROVIDER_TOKEN_${suffix}`) ||
        null;
    const apiKey = String(args.secretConfig?.apiKey || "").trim() ||
        readProviderEnvValue(`INTEGRATION_${domainPrefix}_API_KEY_${suffix}`) ||
        readProviderEnvValue(`INTEGRATION_PROVIDER_API_KEY_${suffix}`) ||
        null;
    const apiKeyHeader = String(args.secretConfig?.apiKeyHeader || "").trim() ||
        readProviderEnvValue(`INTEGRATION_${domainPrefix}_API_KEY_HEADER_${suffix}`) ||
        readProviderEnvValue(`INTEGRATION_PROVIDER_API_KEY_HEADER_${suffix}`) ||
        null;
    return {
        providerCode: args.providerCode,
        baseUrl,
        timeoutMs: Math.max(500, args.timeoutMs),
        token,
        apiKey,
        apiKeyHeader,
    };
}
