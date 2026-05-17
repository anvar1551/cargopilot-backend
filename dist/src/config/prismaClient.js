"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const adapter_pg_1 = require("@prisma/adapter-pg");
function normalizeEnvUrl(raw) {
    if (!raw)
        return undefined;
    const trimmed = raw.trim();
    if (!trimmed)
        return undefined;
    // Handle accidental quoted/multiline values in .env
    const unquoted = (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
        ? trimmed.slice(1, -1)
        : trimmed;
    return unquoted.replace(/\r?\n/g, "").trim();
}
const accelerateUrl = normalizeEnvUrl(process.env.PRISMA_ACCELERATE_URL);
const databaseUrl = normalizeEnvUrl(process.env.DATABASE_URL);
let clientOptions = {};
if (accelerateUrl) {
    clientOptions.accelerateUrl = accelerateUrl;
}
else if (databaseUrl) {
    clientOptions.adapter = new adapter_pg_1.PrismaPg({
        connectionString: databaseUrl,
    });
}
else {
    throw new Error("Prisma requires either PRISMA_ACCELERATE_URL or DATABASE_URL to be set in the environment");
}
const prisma = new client_1.PrismaClient(clientOptions);
exports.default = prisma;
