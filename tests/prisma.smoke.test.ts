import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

let prisma: PrismaClient;

beforeAll(async () => {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter });
  await prisma.$connect();
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
});

test("prisma smoke: SELECT 1", async () => {
  const res = (await prisma.$queryRawUnsafe("SELECT 1 as result")) as Array<{
    result: number;
  }>;
  // Expect the query to return one row with result === 1
  expect(res).toBeDefined();
  expect(res.length).toBeGreaterThan(0);
  expect(res[0]?.result).toBe(1);
}, 30_000);
