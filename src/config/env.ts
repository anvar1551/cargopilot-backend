import { z } from "zod";

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const envNumber = (fallback: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(fallback));

const envBoolean = (fallback: boolean) =>
  z
    .preprocess(emptyToUndefined, z.string().optional())
    .transform((value) => {
      if (value === undefined) return fallback;
      const normalized = value.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(normalized)) return true;
      if (["0", "false", "no", "off"].includes(normalized)) return false;
      throw new Error(`Invalid boolean env value: ${value}`);
    });

const EnvSchema = z.object({
  NODE_ENV: z.string().optional().default("development"),
  PORT: envNumber(4000),
  TRUST_PROXY: envBoolean(true),
  FASTIFY_BODY_LIMIT_BYTES: envNumber(5 * 1024 * 1024),
  CORS_MAX_AGE_SECONDS: envNumber(86_400),
  CLIENT_URL: z.string().optional().default(""),
  CORS_ORIGINS: z.string().optional().default(""),
  ADDITIONAL_ALLOWED_ORIGINS: z.string().optional().default(""),
});

export type AppEnv = z.infer<typeof EnvSchema> & {
  allowedOrigins: string[];
};

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
    allowedOrigins,
  };
}
