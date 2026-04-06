"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const client_1 = require("@prisma/client");
const adapter_pg_1 = require("@prisma/adapter-pg");
let prisma;
beforeAll(async () => {
    const adapter = new adapter_pg_1.PrismaPg({ connectionString: process.env.DATABASE_URL });
    prisma = new client_1.PrismaClient({ adapter });
    await prisma.$connect();
}, 30000);
afterAll(async () => {
    await prisma.$disconnect();
});
test("prisma smoke: SELECT 1", async () => {
    const res = (await prisma.$queryRawUnsafe("SELECT 1 as result"));
    // Expect the query to return one row with result === 1
    expect(res).toBeDefined();
    expect(res.length).toBeGreaterThan(0);
    expect(res[0]?.result).toBe(1);
}, 30000);
