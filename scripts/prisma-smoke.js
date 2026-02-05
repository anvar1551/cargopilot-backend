require("dotenv/config");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");

(async () => {
  console.log("DATABASE_URL set?", !!process.env.DATABASE_URL);
  const url = new URL(process.env.DATABASE_URL);
  console.log(
    "url.username:",
    url.username,
    "url.password type:",
    typeof url.password,
    "length:",
    url.password?.length
  );
  // Pass the connection string using the pg client config key `connectionString` (pg expects this)
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  try {
    const res = await prisma.$queryRawUnsafe("SELECT 1 as result");
    console.log("OK", res);
  } catch (e) {
    console.error("ERROR", e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
})();
