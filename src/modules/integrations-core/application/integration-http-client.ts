import https from "https";
import { checkServerIdentity } from "tls";
import { isIP } from "net";
import { integrationBoundaryError, resolveIntegrationDestination, validateIntegrationUrl } from "./integration-destination";

export type IntegrationHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type IntegrationHttpJsonResponse = {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  rawBody: string;
};

export type IntegrationHttpJsonRequest = {
  url: string;
  providerCode: string;
  method: IntegrationHttpMethod;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  maxResponseBytes?: number;
};

const MAX_ACTIVE_REQUESTS = 32;
let activeRequests = 0;
function bounded(value: unknown, fallback: number, maximum: number) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(maximum, Math.max(100, Math.floor(n))) : fallback;
}
function parseJsonSafe(raw: string): unknown {
  if (!raw.trim()) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

export function isIntegrationHttpRetryableError(error: unknown) {
  const candidate = error as { message?: string; name?: string; code?: string };
  const message = String(candidate?.message || "").toLowerCase();
  const name = String(candidate?.name || "").toLowerCase();
  const code = String(candidate?.code || "").toUpperCase();
  if (code === "ECAPACITY") return true;
  if (["EDESTINATION", "ELIMIT", "EREDIRECT"].includes(code)) return false;
  return (
    name === "aborterror" ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("enotfound") ||
    message.includes("eai_again") ||
    ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EDNS", "ENETWORK"].includes(code)
  );
}

export async function integrationHttpJson(request: IntegrationHttpJsonRequest): Promise<IntegrationHttpJsonResponse> {
  const target = validateIntegrationUrl(request.url, request.providerCode);
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(request.method)) throw integrationBoundaryError("EDESTINATION", "Integration method is not permitted");
  const timeoutMs = bounded(request.timeoutMs, 5000, 15000);
  const maxResponseBytes = bounded(request.maxResponseBytes ?? process.env.INTEGRATION_HTTP_MAX_RESPONSE_BYTES, 1024 * 1024, 4 * 1024 * 1024);
  const headers: Record<string, string> = { "accept-encoding": "identity", host: target.host };
  const forbidden = new Set(["host", "connection", "content-length", "transfer-encoding", "upgrade", "proxy-authorization", "proxy-connection", "te", "trailer", "expect", "accept-encoding"]);
  let headerBytes = 0;
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    const key = name.toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(key) || forbidden.has(key) || typeof value !== "string" || /[\r\n\0]/.test(value)) {
      throw integrationBoundaryError("EDESTINATION", "Integration request header is not permitted");
    }
    headerBytes += Buffer.byteLength(key + value);
    if (headerBytes > 16384 || Object.keys(headers).length >= 32) throw integrationBoundaryError("ELIMIT", "Integration request headers exceed limits");
    headers[key] = value;
  }
  let body: string | undefined;
  try { body = request.method === "GET" ? undefined : JSON.stringify(request.body ?? {}); }
  catch { throw integrationBoundaryError("ELIMIT", "Integration request body is invalid"); }
  if (body !== undefined) {
    if (Buffer.byteLength(body) > 1024 * 1024) throw integrationBoundaryError("ELIMIT", "Integration request body exceeds limits");
    headers["content-type"] ??= "application/json";
    headers["content-length"] = String(Buffer.byteLength(body));
  }
  if (activeRequests >= MAX_ACTIVE_REQUESTS) throw integrationBoundaryError("ECAPACITY", "Integration request capacity reached");
  activeRequests++;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const destination = await resolveIntegrationDestination(target.hostname, controller.signal);
    if (controller.signal.aborted) throw integrationBoundaryError("ETIMEDOUT", "Integration request timed out");
    const tlsHost = target.hostname.replace(/^\[|\]$/g, "");
    return await new Promise<IntegrationHttpJsonResponse>((resolve, reject) => {
      let response: import("http").IncomingMessage | undefined;
      let finished = false;
      let connection: import("net").Socket | undefined;
      let connectionClosed = false;
      let connectTimer: NodeJS.Timeout | undefined;
      const abort = () => finish(integrationBoundaryError("ETIMEDOUT", "Integration request timed out"));
      const req = https.request({
        // No unrestricted lookup/fetch or proxy agent: the TCP target is the validated IP.
        hostname: destination.address, family: destination.family, port: 443,
        servername: isIP(tlsHost) ? "" : tlsHost, rejectUnauthorized: true,
        checkServerIdentity: (_host, certificate) => checkServerIdentity(tlsHost, certificate),
        path: target.pathname + target.search, method: request.method, headers,
        agent: false, maxHeaderSize: 16384,
      });
      function finish(error?: Error, result?: IntegrationHttpJsonResponse) {
        if (finished) return;
        finished = true;
        clearTimeout(connectTimer);
        controller.signal.removeEventListener("abort", abort);
        // Keep admission occupied until the underlying request closes, including timeouts.
        const settle = () => error ? reject(error) : resolve(result!);
        if (connection && !connectionClosed) connection.once("close", settle);
        else if (req.closed) settle(); else req.once("close", settle);
        response?.destroy(); connection?.destroy(); req.destroy();
      }
      req.once("socket", (socket) => {
        connection = socket;
        socket.once("close", () => { connectionClosed = true; });
        connectTimer = setTimeout(() => finish(integrationBoundaryError("ETIMEDOUT", "Integration connect timed out")), Math.min(timeoutMs, 3000));
        socket.once("secureConnect", () => clearTimeout(connectTimer));
      });
      req.once("upgrade", (_response, socket) => { socket.destroy(); finish(integrationBoundaryError("EREDIRECT", "Integration protocol upgrades are not permitted")); });
      req.once("error", () => finish(integrationBoundaryError("ENETWORK", "Integration transport failed")));
      req.once("response", (incoming) => {
        response = incoming;
        incoming.once("error", () => finish(integrationBoundaryError("ENETWORK", "Integration response failed")));
        incoming.once("aborted", () => finish(integrationBoundaryError("ENETWORK", "Integration response aborted")));
        const statusCode = incoming.statusCode ?? 0;
        if (statusCode >= 300 && statusCode < 400) return finish(integrationBoundaryError("EREDIRECT", "Integration redirects are not permitted"));
        const encoding = incoming.headers["content-encoding"];
        if (encoding && encoding !== "identity") return finish(integrationBoundaryError("ELIMIT", "Compressed integration responses are not supported"));
        const declared = incoming.headers["content-length"];
        if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxResponseBytes)) return finish(integrationBoundaryError("ELIMIT", "Integration response exceeds limits"));
        const chunks: Buffer[] = [];
        let bytes = 0;
        incoming.on("data", (chunk: Buffer) => {
          if (finished) return;
          bytes += chunk.length;
          if (bytes > maxResponseBytes) return finish(integrationBoundaryError("ELIMIT", "Integration response exceeds limits"));
          chunks.push(Buffer.from(chunk));
        });
        incoming.once("end", () => {
          if (finished) return;
          const rawBody = Buffer.concat(chunks, bytes).toString("utf8");
          const responseHeaders: Record<string, string> = {};
          // Consumers need no response credentials/cookies.
          for (const key of ["content-type", "retry-after", "x-request-id"]) {
            const value = incoming.headers[key];
            if (typeof value === "string") responseHeaders[key] = value.slice(0, 256);
          }
          finish(undefined, { statusCode, rawBody, body: parseJsonSafe(rawBody), headers: responseHeaders });
        });
      });
      controller.signal.addEventListener("abort", abort, { once: true });
      req.end(body);
    });
  } finally { clearTimeout(timer); activeRequests--; }
}
