import { URL } from "url";
import prisma from "../../../config/prismaClient";
import type { IntegrationProviderRef } from "../domain/types";
import {
  integrationHttpJson,
  isIntegrationHttpRetryableError,
  type IntegrationHttpMethod,
} from "./integration-http-client";
import { decryptIntegrationSecret } from "./integration-secret.crypto";
import type { IntegrationOutboxRecord, OutboxDispatchResult } from "./outbox.types";
import {
  HttpCarrierAdapter,
  HttpSmsAdapter,
  isProviderEnvFallbackEnabled,
  resolveProviderHttpConfig,
  toCarrierCancelInput,
  toCarrierCreateShipmentInput,
  toCarrierTrackInput,
  toSmsSendInput,
  toSmsStatusInput,
} from "./provider-adapters";

type DispatchContext = {
  record: IntegrationOutboxRecord;
  provider: IntegrationProviderRef | null;
  timeoutMs: number;
};

type ProviderSecretConfig = {
  baseUrl?: string | null;
  endpointUrl?: string | null;
  token?: string | null;
  apiKey?: string | null;
  apiKeyHeader?: string | null;
};

export interface IntegrationOutboxDispatcher {
  dispatch(context: DispatchContext): Promise<OutboxDispatchResult>;
}

type IntegrationEventEnvelopeLike = {
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
};

function toObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toProviderSecretConfig(value: unknown): ProviderSecretConfig | null {
  const object = toObject(value);
  if (!object) return null;
  return {
    baseUrl: pickString(object, ["baseUrl"]),
    endpointUrl: pickString(object, ["endpointUrl", "url"]),
    token: pickString(object, ["token", "bearerToken", "accessToken"]),
    apiKey: pickString(object, ["apiKey", "key"]),
    apiKeyHeader: pickString(object, ["apiKeyHeader", "keyHeader"]),
  };
}

function parseSecretPayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { token: raw };
  }
}

async function loadProviderSecretConfig(
  provider: IntegrationProviderRef | null,
): Promise<ProviderSecretConfig | null> {
  if (!provider?.secretRef) return null;
  const row = await (prisma as any).integrationProviderSecret.findUnique({
    where: { id: provider.secretRef },
    select: { encryptedSecretJson: true },
  });
  if (!row?.encryptedSecretJson) return null;
  const raw = decryptIntegrationSecret(row.encryptedSecretJson);
  return toProviderSecretConfig(parseSecretPayload(raw));
}

function pickString(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function parseEnvelope(value: unknown): IntegrationEventEnvelopeLike | null {
  const object = toObject(value);
  if (!object) return null;
  const eventType = pickString(object, ["eventType", "type"]);
  const aggregateId = pickString(object, ["aggregateId", "id"]) || "";
  const payloadObject = toObject(object.payload) || object;
  if (!eventType) return null;
  return {
    eventType,
    aggregateId,
    payload: payloadObject,
  };
}

function toHeaders(value: unknown) {
  const headersRecord = toObject(value);
  if (!headersRecord) return {};
  return Object.entries(headersRecord).reduce<Record<string, string>>(
    (acc, [key, headerValue]) => {
      if (typeof headerValue === "string" && headerValue.trim()) {
        acc[key] = headerValue.trim();
      } else if (typeof headerValue === "number" || typeof headerValue === "bigint") {
        acc[key] = String(headerValue);
      }
      return acc;
    },
    {},
  );
}

function normalizeProviderCode(value: string) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function resolveEndpointUrl(
  record: IntegrationOutboxRecord,
  secretConfig?: ProviderSecretConfig | null,
): string | null {
  const payload = toObject(record.payload) || {};
  const endpointFromPayload = pickString(payload, ["endpointUrl", "webhookUrl", "url"]);
  if (endpointFromPayload) return endpointFromPayload;
  const endpointFromSecret = secretConfig?.endpointUrl || secretConfig?.baseUrl;
  if (endpointFromSecret?.trim()) return endpointFromSecret.trim();

  if (!isProviderEnvFallbackEnabled()) return null;

  const providerCode = normalizeProviderCode(record.providerCode);
  const envEndpoint = String(
    process.env[`INTEGRATION_PROVIDER_ENDPOINT_${providerCode}`] || "",
  ).trim();
  return envEndpoint || null;
}

function headersFromSecretConfig(secretConfig?: ProviderSecretConfig | null) {
  const headers: Record<string, string> = {};
  if (secretConfig?.token?.trim()) {
    headers.authorization = `Bearer ${secretConfig.token.trim()}`;
  }
  if (secretConfig?.apiKey?.trim()) {
    headers[(secretConfig.apiKeyHeader || "x-api-key").trim().toLowerCase()] =
      secretConfig.apiKey.trim();
  }
  return headers;
}

function resolveHttpMethod(record: IntegrationOutboxRecord): IntegrationHttpMethod {
  const payload = toObject(record.payload) || {};
  const method = pickString(payload, ["method", "httpMethod"]);
  if (!method) return "POST";
  const normalized = method.toUpperCase();
  if (["GET", "POST", "PUT", "PATCH", "DELETE"].includes(normalized)) {
    return normalized as IntegrationHttpMethod;
  }
  return "POST";
}

function resolveBody(record: IntegrationOutboxRecord) {
  const payload = toObject(record.payload) || {};
  return payload.body ?? record.payload;
}

const unsupportedDispatcher: IntegrationOutboxDispatcher = {
  async dispatch(context) {
    return {
      sent: false,
      retryable: false,
      message: `No dispatcher is implemented for domain '${context.record.domain}'`,
      statusCode: null,
    };
  },
};

const webhookSinkDispatcher: IntegrationOutboxDispatcher = {
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

    let target: URL;
    try {
      target = new URL(endpointUrl);
    } catch {
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
      const response = await integrationHttpJson({
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
        message:
          response.statusCode >= 200 && response.statusCode < 300
            ? undefined
            : `Endpoint returned ${response.statusCode}`,
      };
    } catch (error: any) {
      const message = String(error?.message || "dispatch failed");
      return {
        sent: false,
        retryable: isIntegrationHttpRetryableError(error),
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

function dispatchResultFromIntegrationResult(
  result: IntegrationResultLike,
  requestJson?: Record<string, unknown> | null,
  responseJson?: Record<string, unknown> | null,
): OutboxDispatchResult {
  return {
    sent: Boolean(result.ok),
    retryable: Boolean(result.retryable),
    statusCode:
      typeof result.providerStatusCode === "number" ? result.providerStatusCode : null,
    providerRequestId: result.providerRequestId ?? null,
    message: result.message,
    requestJson: requestJson ?? null,
    responseJson: responseJson ?? (toObject(result.data) || null),
  };
}

type IntegrationResultLike = {
  ok: boolean;
  providerRequestId?: string | null;
  providerStatusCode?: number | null;
  retryable?: boolean;
  message?: string;
  data?: unknown;
};

const carrierDispatcher: IntegrationOutboxDispatcher = {
  async dispatch(context) {
    if (!context.provider) {
      return {
        sent: false,
        retryable: true,
        statusCode: null,
        message: "Carrier provider not found",
      };
    }

    const config = resolveProviderHttpConfig({
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

    const action =
      pickString(envelope.payload, ["action", "op"]) ||
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

    const adapter = new HttpCarrierAdapter(config);
    const integrationContext = {
      requestId: context.record.id,
      companyId: context.record.companyId,
      idempotencyKey: context.record.idempotencyKey,
      initiatedBy: "worker" as const,
    };

    if (action === "create_shipment") {
      const input = toCarrierCreateShipmentInput(envelope.payload, envelope.aggregateId);
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
      const input = toCarrierCancelInput(envelope.payload);
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
      const input = toCarrierTrackInput(envelope.payload);
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

const smsDispatcher: IntegrationOutboxDispatcher = {
  async dispatch(context) {
    if (!context.provider) {
      return {
        sent: false,
        retryable: true,
        statusCode: null,
        message: "SMS provider not found",
      };
    }

    const config = resolveProviderHttpConfig({
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

    const action =
      pickString(envelope.payload, ["action", "op"]) ||
      (envelope.eventType === "sms.delivery.updated" ? "status" : "send");

    const adapter = new HttpSmsAdapter(config);
    const integrationContext = {
      requestId: context.record.id,
      companyId: context.record.companyId,
      idempotencyKey: context.record.idempotencyKey,
      initiatedBy: "worker" as const,
    };

    if (action === "send") {
      const input = toSmsSendInput(envelope.payload);
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
      const input = toSmsStatusInput(envelope.payload);
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

export function resolveIntegrationOutboxDispatcher(
  record: IntegrationOutboxRecord,
  provider: IntegrationProviderRef | null,
): IntegrationOutboxDispatcher {
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

  if (record.domain === "webhook_sink") return webhookSinkDispatcher;
  if (record.domain === "carrier") return carrierDispatcher;
  if (record.domain === "sms") return smsDispatcher;

  return unsupportedDispatcher;
}
