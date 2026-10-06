import { Prisma } from "@prisma/client";

/** Reference pins, not authorization. Callers must verify context/possession and
 * current eligibility themselves. Match credential administration's User ->
 * membership order before any grant or refresh-lineage fence; select no secrets. */
export async function lockSelectedIdentityReferences(tx: Prisma.TransactionClient, context: {
  userId: string; tenantId: string; companyId: string;
  tenantMembershipId: string; companyMembershipId: string;
}) {
  await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
  await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
  const identity = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM "User" WHERE id = ${context.userId}::uuid FOR KEY SHARE`);
  if (identity.length !== 1 || identity[0].id !== context.userId) return false;
  const selected = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM "CompanyMembership" WHERE id = ${context.companyMembershipId}::uuid
      AND "userId" = ${context.userId}::uuid AND "tenantId" = ${context.tenantId}::uuid
      AND "companyId" = ${context.companyId}::uuid AND "tenantMembershipId" = ${context.tenantMembershipId}::uuid
    FOR KEY SHARE`);
  return selected.length === 1 && selected[0].id === context.companyMembershipId;
}

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
