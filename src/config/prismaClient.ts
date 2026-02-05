import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const accelerateUrl = process.env.PRISMA_ACCELERATE_URL;

let clientOptions: Record<string, unknown> = {};

if (accelerateUrl) {
  clientOptions.accelerateUrl = accelerateUrl;
} else if (process.env.DATABASE_URL) {
  clientOptions.adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  });
} else {
  throw new Error(
    "Prisma requires either PRISMA_ACCELERATE_URL or DATABASE_URL to be set in the environment"
  );
}

const prisma = new PrismaClient(clientOptions as any);

export default prisma;
