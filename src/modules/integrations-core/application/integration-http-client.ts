export type IntegrationHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type IntegrationHttpJsonResponse = {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  rawBody: string;
};

export type IntegrationHttpJsonRequest = {
  url: string;
  method: IntegrationHttpMethod;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  maxResponseBytes?: number;
};

const DEFAULT_MAX_RESPONSE_BYTES = Math.max(
  16 * 1024,
  Number(process.env.INTEGRATION_HTTP_MAX_RESPONSE_BYTES || 1024 * 1024),
);

function parseJsonSafe(raw: string): unknown {
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function normalizeHeaders(headers: Headers) {
  const normalized: Record<string, string> = {};
  headers.forEach((value, key) => {
    normalized[key.toLowerCase()] = value;
  });
  return normalized;
}

function timeoutError(timeoutMs: number) {
  return new Error(`request timed out after ${timeoutMs}ms`);
}

export function isIntegrationHttpRetryableError(error: unknown) {
  const candidate = error as { message?: string; name?: string; code?: string };
  const message = String(candidate?.message || "").toLowerCase();
  const name = String(candidate?.name || "").toLowerCase();
  const code = String(candidate?.code || "").toUpperCase();
  return (
    name === "aborterror" ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("enotfound") ||
    message.includes("eai_again") ||
    ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT"].includes(code)
  );
}

export async function integrationHttpJson(
  request: IntegrationHttpJsonRequest,
): Promise<IntegrationHttpJsonResponse> {
  const timeoutMs = Math.max(100, Math.trunc(Number(request.timeoutMs || 0)));
  const maxResponseBytes = Math.max(
    1024,
    Math.trunc(Number(request.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES)),
  );
  const target = new URL(request.url);
  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error("Only HTTP/HTTPS URLs are supported");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(timeoutError(timeoutMs));
  }, timeoutMs);

  const hasBody = request.method !== "GET";
  const headers: Record<string, string> = {
    ...(hasBody ? { "content-type": "application/json" } : {}),
    ...(request.headers ?? {}),
  };

  let response: Response;
  try {
    response = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? JSON.stringify(request.body ?? {}) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw timeoutError(timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const rawBody = await response.text();
  if (Buffer.byteLength(rawBody, "utf8") > maxResponseBytes) {
    throw new Error(`response body exceeded ${maxResponseBytes} bytes`);
  }

  return {
    statusCode: response.status,
    headers: normalizeHeaders(response.headers),
    rawBody,
    body: parseJsonSafe(rawBody),
  };
}
