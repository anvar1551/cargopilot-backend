import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

function normalizeEnvUrl(raw: string | undefined) {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // Handle accidental quoted/multiline values in .env
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed;

  return unquoted.replace(/\r?\n/g, "").trim();
}

const accelerateUrl = normalizeEnvUrl(process.env.PRISMA_ACCELERATE_URL);
const databaseUrl = normalizeEnvUrl(process.env.DATABASE_URL);

let clientOptions: Record<string, unknown> = {};

if (accelerateUrl) {
  clientOptions.accelerateUrl = accelerateUrl;
} else if (databaseUrl) {
  clientOptions.adapter = new PrismaPg({
    connectionString: databaseUrl,
  });
} else {
  throw new Error(
    "Prisma requires either PRISMA_ACCELERATE_URL or DATABASE_URL to be set in the environment"
  );
}

const prisma = new PrismaClient(clientOptions as any);

export default prisma;
