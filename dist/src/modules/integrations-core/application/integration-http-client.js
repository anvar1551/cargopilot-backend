"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isIntegrationHttpRetryableError = isIntegrationHttpRetryableError;
exports.integrationHttpJson = integrationHttpJson;
const DEFAULT_MAX_RESPONSE_BYTES = Math.max(16 * 1024, Number(process.env.INTEGRATION_HTTP_MAX_RESPONSE_BYTES || 1024 * 1024));
function parseJsonSafe(raw) {
    if (!raw.trim())
        return null;
    try {
        return JSON.parse(raw);
    }
    catch {
        return raw;
    }
}
function normalizeHeaders(headers) {
    const normalized = {};
    headers.forEach((value, key) => {
        normalized[key.toLowerCase()] = value;
    });
    return normalized;
}
function timeoutError(timeoutMs) {
    return new Error(`request timed out after ${timeoutMs}ms`);
}
function isIntegrationHttpRetryableError(error) {
    const candidate = error;
    const message = String(candidate?.message || "").toLowerCase();
    const name = String(candidate?.name || "").toLowerCase();
    const code = String(candidate?.code || "").toUpperCase();
    return (name === "aborterror" ||
        message.includes("timed out") ||
        message.includes("timeout") ||
        message.includes("econnreset") ||
        message.includes("econnrefused") ||
        message.includes("enotfound") ||
        message.includes("eai_again") ||
        ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT"].includes(code));
}
async function integrationHttpJson(request) {
    const timeoutMs = Math.max(100, Math.trunc(Number(request.timeoutMs || 0)));
    const maxResponseBytes = Math.max(1024, Math.trunc(Number(request.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES)));
    const target = new URL(request.url);
    if (!["http:", "https:"].includes(target.protocol)) {
        throw new Error("Only HTTP/HTTPS URLs are supported");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort(timeoutError(timeoutMs));
    }, timeoutMs);
    const hasBody = request.method !== "GET";
    const headers = {
        ...(hasBody ? { "content-type": "application/json" } : {}),
        ...(request.headers ?? {}),
    };
    let response;
    try {
        response = await fetch(target, {
            method: request.method,
            headers,
            body: hasBody ? JSON.stringify(request.body ?? {}) : undefined,
            signal: controller.signal,
        });
    }
    catch (error) {
        if (controller.signal.aborted) {
            throw timeoutError(timeoutMs);
        }
        throw error;
    }
    finally {
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
