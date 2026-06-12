"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveIntegrationOutboxDispatcher = resolveIntegrationOutboxDispatcher;
const url_1 = require("url");
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const integration_http_client_1 = require("./integration-http-client");
const integration_secret_crypto_1 = require("./integration-secret.crypto");
const provider_adapters_1 = require("./provider-adapters");
function toObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    return value;
}
function toProviderSecretConfig(value) {
    const object = toObject(value);
    if (!object)
        return null;
    return {
        baseUrl: pickString(object, ["baseUrl"]),
        endpointUrl: pickString(object, ["endpointUrl", "url"]),
        token: pickString(object, ["token", "bearerToken", "accessToken"]),
        apiKey: pickString(object, ["apiKey", "key"]),
        apiKeyHeader: pickString(object, ["apiKeyHeader", "keyHeader"]),
    };
}
function parseSecretPayload(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return { token: raw };
    }
}
async function loadProviderSecretConfig(provider) {
    if (!provider?.secretRef)
        return null;
    const row = await prismaClient_1.default.integrationProviderSecret.findUnique({
        where: { id: provider.secretRef },
        select: { encryptedSecretJson: true },
    });
    if (!row?.encryptedSecretJson)
        return null;
    const raw = (0, integration_secret_crypto_1.decryptIntegrationSecret)(row.encryptedSecretJson);
    return toProviderSecretConfig(parseSecretPayload(raw));
}
function pickString(payload, keys) {
    for (const key of keys) {
        const value = payload[key];
        if (typeof value === "string" && value.trim())
            return value.trim();
    }
    return null;
}
function parseEnvelope(value) {
    const object = toObject(value);
    if (!object)
        return null;
    const eventType = pickString(object, ["eventType", "type"]);
    const aggregateId = pickString(object, ["aggregateId", "id"]) || "";
    const payloadObject = toObject(object.payload) || object;
    if (!eventType)
        return null;
    return {
        eventType,
        aggregateId,
        payload: payloadObject,
    };
}
function toHeaders(value) {
    const headersRecord = toObject(value);
    if (!headersRecord)
        return {};
    return Object.entries(headersRecord).reduce((acc, [key, headerValue]) => {
        if (typeof headerValue === "string" && headerValue.trim()) {
            acc[key] = headerValue.trim();
        }
        else if (typeof headerValue === "number" || typeof headerValue === "bigint") {
            acc[key] = String(headerValue);
        }
        return acc;
    }, {});
}
function normalizeProviderCode(value) {
    return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "_");
}
function resolveEndpointUrl(record, secretConfig) {
    const payload = toObject(record.payload) || {};
    const endpointFromPayload = pickString(payload, ["endpointUrl", "webhookUrl", "url"]);
    if (endpointFromPayload)
        return endpointFromPayload;
    const endpointFromSecret = secretConfig?.endpointUrl || secretConfig?.baseUrl;
    if (endpointFromSecret?.trim())
        return endpointFromSecret.trim();
    if (!(0, provider_adapters_1.isProviderEnvFallbackEnabled)())
        return null;
    const providerCode = normalizeProviderCode(record.providerCode);
    const envEndpoint = String(process.env[`INTEGRATION_PROVIDER_ENDPOINT_${providerCode}`] || "").trim();
    return envEndpoint || null;
}
function headersFromSecretConfig(secretConfig) {
    const headers = {};
    if (secretConfig?.token?.trim()) {
        headers.authorization = `Bearer ${secretConfig.token.trim()}`;
    }
    if (secretConfig?.apiKey?.trim()) {
        headers[(secretConfig.apiKeyHeader || "x-api-key").trim().toLowerCase()] =
            secretConfig.apiKey.trim();
    }
    return headers;
}
function resolveHttpMethod(record) {
    const payload = toObject(record.payload) || {};
    const method = pickString(payload, ["method", "httpMethod"]);
    if (!method)
        return "POST";
    const normalized = method.toUpperCase();
    if (["GET", "POST", "PUT", "PATCH", "DELETE"].includes(normalized)) {
        return normalized;
    }
    return "POST";
}
function resolveBody(record) {
    const payload = toObject(record.payload) || {};
    return payload.body ?? record.payload;
}
const unsupportedDispatcher = {
    async dispatch(context) {
        return {
            sent: false,
            retryable: false,
            message: `No dispatcher is implemented for domain '${context.record.domain}'`,
            statusCode: null,
        };
    },
};
const webhookSinkDispatcher = {
    async dispatch(context) {
        const secretConfig = await loadProviderSecretConfig(context.provider);
        const endpointUrl = resolveEndpointUrl(context.record, secretConfig);
        if (!endpointUrl) {
            return {
                sent: false,
                retryable: false,
                message: `No endpoint URL is configured for provider '${context.record.providerCode}'`,
            };
        }
        let target;
        try {
            target = new url_1.URL(endpointUrl);
        }
        catch {
            return {
                sent: false,
                retryable: false,
                message: "Endpoint URL is invalid",
            };
        }
        if (!["http:", "https:"].includes(target.protocol)) {
            return {
                sent: false,
                retryable: false,
                message: "Only HTTP/HTTPS endpoint URLs are supported",
            };
        }
        const payload = toObject(context.record.payload) || {};
        const method = resolveHttpMethod(context.record);
        const customHeaders = toHeaders(payload.headers);
        const body = resolveBody(context.record);
        const timeoutMs = Math.max(500, context.timeoutMs);
        const headers = {
            "x-cargopilot-provider-code": context.record.providerCode,
            "x-cargopilot-idempotency-key": context.record.idempotencyKey,
            "x-cargopilot-event-type": context.record.eventType,
            ...headersFromSecretConfig(secretConfig),
            ...customHeaders,
        };
        try {
            const response = await (0, integration_http_client_1.integrationHttpJson)({
                url: target.toString(),
                method,
                headers,
                body,
                timeoutMs,
            });
            const retryable = response.statusCode === 429 || response.statusCode >= 500;
            return {
                sent: response.statusCode >= 200 && response.statusCode < 300,
                retryable,
                statusCode: response.statusCode || null,
                responseJson: toObject(response.body) || { value: response.body },
                requestJson: {
                    url: target.toString(),
                    method,
                },
                message: response.statusCode >= 200 && response.statusCode < 300
                    ? undefined
                    : `Endpoint returned ${response.statusCode}`,
            };
        }
        catch (error) {
            const message = String(error?.message || "dispatch failed");
            return {
                sent: false,
                retryable: (0, integration_http_client_1.isIntegrationHttpRetryableError)(error),
                statusCode: null,
                requestJson: {
                    url: target.toString(),
                    method,
                },
                message,
            };
        }
    },
};
function dispatchResultFromIntegrationResult(result, requestJson, responseJson) {
    return {
        sent: Boolean(result.ok),
        retryable: Boolean(result.retryable),
        statusCode: typeof result.providerStatusCode === "number" ? result.providerStatusCode : null,
        providerRequestId: result.providerRequestId ?? null,
        message: result.message,
        requestJson: requestJson ?? null,
        responseJson: responseJson ?? (toObject(result.data) || null),
    };
}
const carrierDispatcher = {
    async dispatch(context) {
        if (!context.provider) {
            return {
                sent: false,
                retryable: true,
                statusCode: null,
                message: "Carrier provider not found",
            };
        }
        const config = (0, provider_adapters_1.resolveProviderHttpConfig)({
            domain: "carrier",
            providerCode: context.provider.providerCode,
            timeoutMs: context.timeoutMs,
            secretConfig: await loadProviderSecretConfig(context.provider),
        });
        if (!config) {
            return {
                sent: false,
                retryable: false,
                statusCode: null,
                message: `Carrier base URL is not configured for provider '${context.provider.providerCode}'`,
            };
        }
        const envelope = parseEnvelope(context.record.payload);
        if (!envelope) {
            return {
                sent: false,
                retryable: false,
                statusCode: null,
                message: "Outbox payload is not a valid integration event envelope",
            };
        }
        const action = pickString(envelope.payload, ["action", "op"]) ||
            (["order.created", "shipment.assigned"].includes(envelope.eventType)
                ? "create_shipment"
                : envelope.eventType === "order.status.changed"
                    ? "cancel_shipment"
                    : envelope.eventType === "carrier.status.updated"
                        ? "track"
                        : null);
        if (!action) {
            return {
                sent: false,
                retryable: false,
                statusCode: null,
                message: `Unsupported carrier eventType '${envelope.eventType}'`,
            };
        }
        const adapter = new provider_adapters_1.HttpCarrierAdapter(config);
        const integrationContext = {
            requestId: context.record.id,
            companyId: context.record.companyId,
            idempotencyKey: context.record.idempotencyKey,
            initiatedBy: "worker",
        };
        if (action === "create_shipment") {
            const input = (0, provider_adapters_1.toCarrierCreateShipmentInput)(envelope.payload, envelope.aggregateId);
            if (!input) {
                return {
                    sent: false,
                    retryable: false,
                    statusCode: null,
                    message: "Carrier create_shipment payload is invalid",
                };
            }
            const result = await adapter.createShipment(input, integrationContext);
            return dispatchResultFromIntegrationResult(result, {
                action,
                input,
            });
        }
        if (action === "cancel_shipment") {
            const input = (0, provider_adapters_1.toCarrierCancelInput)(envelope.payload);
            if (!input) {
                return {
                    sent: false,
                    retryable: false,
                    statusCode: null,
                    message: "Carrier cancel_shipment payload is invalid",
                };
            }
            const result = await adapter.cancelShipment(input, integrationContext);
            return dispatchResultFromIntegrationResult(result, {
                action,
                input,
            });
        }
        if (action === "track") {
            const input = (0, provider_adapters_1.toCarrierTrackInput)(envelope.payload);
            if (!input) {
                return {
                    sent: false,
                    retryable: false,
                    statusCode: null,
                    message: "Carrier track payload is invalid",
                };
            }
            const result = await adapter.track(input, integrationContext);
            return dispatchResultFromIntegrationResult(result, {
                action,
                input,
            });
        }
        return {
            sent: false,
            retryable: false,
            statusCode: null,
            message: `Unsupported carrier action '${action}'`,
        };
    },
};
const smsDispatcher = {
    async dispatch(context) {
        if (!context.provider) {
            return {
                sent: false,
                retryable: true,
                statusCode: null,
                message: "SMS provider not found",
            };
        }
        const config = (0, provider_adapters_1.resolveProviderHttpConfig)({
            domain: "sms",
            providerCode: context.provider.providerCode,
            timeoutMs: context.timeoutMs,
            secretConfig: await loadProviderSecretConfig(context.provider),
        });
        if (!config) {
            return {
                sent: false,
                retryable: false,
                statusCode: null,
                message: `SMS base URL is not configured for provider '${context.provider.providerCode}'`,
            };
        }
        const envelope = parseEnvelope(context.record.payload);
        if (!envelope) {
            return {
                sent: false,
                retryable: false,
                statusCode: null,
                message: "Outbox payload is not a valid integration event envelope",
            };
        }
        const action = pickString(envelope.payload, ["action", "op"]) ||
            (envelope.eventType === "sms.delivery.updated" ? "status" : "send");
        const adapter = new provider_adapters_1.HttpSmsAdapter(config);
        const integrationContext = {
            requestId: context.record.id,
            companyId: context.record.companyId,
            idempotencyKey: context.record.idempotencyKey,
            initiatedBy: "worker",
        };
        if (action === "send") {
            const input = (0, provider_adapters_1.toSmsSendInput)(envelope.payload);
            if (!input) {
                return {
                    sent: false,
                    retryable: false,
                    statusCode: null,
                    message: "SMS send payload is invalid",
                };
            }
            const result = await adapter.send(input, integrationContext);
            return dispatchResultFromIntegrationResult(result, {
                action,
                input,
            });
        }
        if (action === "status") {
            const input = (0, provider_adapters_1.toSmsStatusInput)(envelope.payload);
            if (!input) {
                return {
                    sent: false,
                    retryable: false,
                    statusCode: null,
                    message: "SMS status payload is invalid",
                };
            }
            const result = await adapter.getDeliveryStatus(input, integrationContext);
            return dispatchResultFromIntegrationResult(result, {
                action,
                input,
            });
        }
        return {
            sent: false,
            retryable: false,
            statusCode: null,
            message: `Unsupported SMS action '${action}'`,
        };
    },
};
function resolveIntegrationOutboxDispatcher(record, provider) {
    if (!provider || provider.status !== "active") {
        return {
            async dispatch() {
                return {
                    sent: false,
                    retryable: true,
                    statusCode: null,
                    message: "Provider is not active or not found",
                };
            },
        };
    }
    if (record.domain === "webhook_sink")
        return webhookSinkDispatcher;
    if (record.domain === "carrier")
        return carrierDispatcher;
    if (record.domain === "sms")
        return smsDispatcher;
    return unsupportedDispatcher;
}
