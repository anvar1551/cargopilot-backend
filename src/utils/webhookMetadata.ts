import { createHash } from "crypto";

/** Never use this projection as signature input. Original headers remain verifier-only. */
export function webhookHeadersForStorage(headers: Record<string, unknown>): Record<string, string> {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const safe: Record<string, string> = {};
  const contentType = normalized.get("content-type");
  if (typeof contentType === "string") {
    const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
    if (["application/json", "application/x-www-form-urlencoded", "text/plain"].includes(mediaType)) safe["content-type"] = mediaType;
  }
  for (const key of ["x-request-id", "x-correlation-id", "x-event-id"]) {
    const value = normalized.get(key);
    // Preserve canonical UUIDs; hash other bounded opaque identifiers so a misplaced
    // credential cannot be retained in reusable form under an innocent header name.
    if (typeof value !== "string" || !value || value.length > 256 || /[\x00-\x20\x7f]/.test(value)) continue;
    if (/^sha256:[a-f0-9]{64}$/.test(value)) { safe[key] = value; continue; }
    safe[key] = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      ? value.toLowerCase() : `sha256:${createHash("sha256").update(value).digest("hex")}`;
  }
  return safe;
}

export function paymentWebhookMetadata(headers: Record<string, unknown>, rawBody: string | Buffer | undefined, body: unknown, verified: boolean) {
  const rawAvailable = typeof rawBody === "string" || Buffer.isBuffer(rawBody);
  return {
    headers: webhookHeadersForStorage(headers),
    payloadSha256: createHash("sha256").update(rawAvailable ? rawBody! : JSON.stringify(body)).digest("hex"),
    digestSource: rawAvailable ? "raw_body" : "parsed_json",
    signatureVerified: verified,
  };
}
