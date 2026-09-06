import { isIP } from "net";
import { z } from "zod";

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const envNumber = (fallback: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(fallback));

const EnvSchema = z.object({
  NODE_ENV: z.string().optional().default("development"),
  PORT: envNumber(4000),
  TRUST_PROXY: z.string().optional().default("false"),
  FASTIFY_BODY_LIMIT_BYTES: envNumber(5 * 1024 * 1024),
  CORS_MAX_AGE_SECONDS: envNumber(86_400),
  CLIENT_URL: z.string().optional().default(""),
  CORS_ORIGINS: z.string().optional().default(""),
  ADDITIONAL_ALLOWED_ORIGINS: z.string().optional().default(""),
});

export type TrustedProxyConfig = false | number | string[];

export type AppEnv = Omit<z.infer<typeof EnvSchema>, "TRUST_PROXY"> & {
  TRUST_PROXY: TrustedProxyConfig;
  allowedOrigins: string[];
};

const TRUSTED_PROXY_NAMES = new Set(["loopback", "linklocal", "uniquelocal"]);

function isTrustedProxyAddress(value: string) {
  const normalized = value.trim().toLowerCase();
  if (TRUSTED_PROXY_NAMES.has(normalized)) return true;
  const [address, prefix, ...rest] = normalized.split("/");
  if (rest.length > 0 || !address) return false;
  const family = isIP(address);
  if (!family) return false;
  if (prefix === undefined) return true;
  if (!/^\d+$/.test(prefix)) return false;
  const bits = Number(prefix);
  return family === 4 ? bits > 0 && bits <= 32 : bits > 0 && bits <= 128;
}

export function parseTrustedProxy(value: string | undefined): TrustedProxyConfig {
  const normalized = String(value ?? "").trim();
  if (!normalized || ["0", "false", "no", "off"].includes(normalized.toLowerCase())) {
    return false;
  }
  if (["true", "yes", "on"].includes(normalized.toLowerCase())) {
    throw new Error(
      "TRUST_PROXY must name trusted IP/CIDR proxies or a positive trusted-hop count; trust-all is prohibited",
    );
  }
  if (/^\d+$/.test(normalized)) {
    const hops = Number(normalized);
    if (Number.isSafeInteger(hops) && hops > 0) return hops;
    throw new Error("TRUST_PROXY hop count must be a positive integer");
  }

  const addresses = normalized
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (addresses.length === 0 || addresses.some((item) => !isTrustedProxyAddress(item))) {
    throw new Error("TRUST_PROXY contains an invalid trusted proxy address or CIDR");
  }
  return addresses;
}

function splitCsv(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadAppEnv(rawEnv: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = EnvSchema.parse(rawEnv);
  const allowedOrigins = Array.from(
    new Set([
      parsed.CLIENT_URL.trim(),
      ...splitCsv(parsed.CORS_ORIGINS),
      ...splitCsv(parsed.ADDITIONAL_ALLOWED_ORIGINS),
    ].filter(Boolean)),
  );

  return {
    ...parsed,
    TRUST_PROXY: parseTrustedProxy(parsed.TRUST_PROXY),
    allowedOrigins,
  };
}
