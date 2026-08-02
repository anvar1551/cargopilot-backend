"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadAppEnv = loadAppEnv;
const zod_1 = require("zod");
const emptyToUndefined = (value) => typeof value === "string" && value.trim() === "" ? undefined : value;
const envNumber = (fallback) => zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(fallback));
const envBoolean = (fallback) => zod_1.z
    .preprocess(emptyToUndefined, zod_1.z.string().optional())
    .transform((value) => {
    if (value === undefined)
        return fallback;
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized))
        return true;
    if (["0", "false", "no", "off"].includes(normalized))
        return false;
    throw new Error(`Invalid boolean env value: ${value}`);
});
const EnvSchema = zod_1.z.object({
    NODE_ENV: zod_1.z.string().optional().default("development"),
    PORT: envNumber(4000),
    TRUST_PROXY: envBoolean(true),
    FASTIFY_BODY_LIMIT_BYTES: envNumber(5 * 1024 * 1024),
    CORS_MAX_AGE_SECONDS: envNumber(86400),
    CLIENT_URL: zod_1.z.string().optional().default(""),
    CORS_ORIGINS: zod_1.z.string().optional().default(""),
    ADDITIONAL_ALLOWED_ORIGINS: zod_1.z.string().optional().default(""),
});
function splitCsv(value) {
    return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}
function loadAppEnv(rawEnv = process.env) {
    const parsed = EnvSchema.parse(rawEnv);
    const allowedOrigins = Array.from(new Set([
        parsed.CLIENT_URL.trim(),
        ...splitCsv(parsed.CORS_ORIGINS),
        ...splitCsv(parsed.ADDITIONAL_ALLOWED_ORIGINS),
    ].filter(Boolean)));
    return {
        ...parsed,
        allowedOrigins,
    };
}
