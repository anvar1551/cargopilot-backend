import { Prisma } from "@prisma/client";

/** Internal credential value only; never project, log or include in an error. */
export async function lockCredentialUser(tx: Prisma.TransactionClient, userId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) throw new Error("Unauthorized");
  await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
  await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
  const rows = await tx.$queryRaw<Array<{ id: string; password: string }>>(Prisma.sql`
    SELECT id, password FROM "User" WHERE id = ${userId}::uuid FOR UPDATE`);
  if (rows.length !== 1 || rows[0].id !== userId || typeof rows[0].password !== "string") throw new Error("Unauthorized");
  return rows[0];
}
