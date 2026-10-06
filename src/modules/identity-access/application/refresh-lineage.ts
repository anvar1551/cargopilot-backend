import { Prisma } from "@prisma/client";
import { lockSelectedIdentityReferences } from "./credential-lock";
import type { RefreshTokenPayload } from "../types";
export const MAX_REFRESH_ROTATION_DEPTH = 256;
const transactionOptions = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 2000, timeout: 10000 };
export { transactionOptions as refreshLineageTransactionOptions };
const invalid = () => new Error("Refresh lineage unavailable");
const identitySelect = { id: true, userId: true, tenantId: true, tenantMembershipId: true, companyMembershipId: true,
  companyMembership: { select: { companyId: true } } } as const;
type Identity = { userId: string; tenantId: string | null; tenantMembershipId: string | null; companyMembershipId: string | null };
type Node = Identity & { id: string; rotationDepth: number; replacementDepth: number | null; replacedBySessionId: string | null; revokedAt: Date | null };

export async function lockRefreshContext(tx: Prisma.TransactionClient, context: Identity) {
  if (!context.userId || !context.tenantId || !context.tenantMembershipId || !context.companyMembershipId) throw invalid();
  await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
  await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
  const key = `refresh-lineage:${context.tenantId}:${context.userId}:${context.companyMembershipId}`;
  // Cast the void result: Prisma cannot deserialize PostgreSQL void.
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`);
}

/** Signature/purpose validation happens at ingress; possession is rechecked in PostgreSQL. */
export async function revokeRecordedSuccessors(tx: Prisma.TransactionClient, claims: RefreshTokenPayload, tokenHash: string) {
  const where = {
    id: claims.sid, userId: claims.id, tokenHash,
    tenantId: claims.tenantId, tenantMembershipId: claims.tenantMembershipId,
    companyMembershipId: claims.companyMembershipId,
    companyMembership: { is: { id: claims.companyMembershipId, userId: claims.id, tenantId: claims.tenantId,
      tenantMembershipId: claims.tenantMembershipId, companyId: claims.companyId } },
  };
  const origin = await tx.userRefreshSession.findFirst({ where, select: identitySelect });
  if (!origin) return;
  if (origin.id !== claims.sid || origin.userId !== claims.id || origin.tenantId !== claims.tenantId ||
      origin.tenantMembershipId !== claims.tenantMembershipId || origin.companyMembershipId !== claims.companyMembershipId
      || origin.companyMembership?.companyId !== claims.companyId) throw invalid();
  // Possession/context matched above. Pin its existing FK references before the
  // lineage fence: grant revocation takes membership locks before this fence.
  // Otherwise logout's audit FK and revocation can wait on each other.
  if (!await lockSelectedIdentityReferences(tx, { userId: origin.userId,
    tenantId: origin.tenantId!, companyId: origin.companyMembership!.companyId,
    tenantMembershipId: origin.tenantMembershipId!, companyMembershipId: origin.companyMembershipId! })) throw invalid();
  await lockRefreshContext(tx, origin);
  const load = async (id: string, exactHash?: string): Promise<Node | undefined> => {
    const rows = await tx.$queryRaw<Node[]>(Prisma.sql`
      SELECT s.id, s."userId", s."tenantId", s."tenantMembershipId", s."companyMembershipId",
        s."rotationDepth", s."replacementDepth", s."replacedBySessionId", s."revokedAt"
      FROM "UserRefreshSession" s JOIN "CompanyMembership" m ON m.id = s."companyMembershipId"
      WHERE s.id = ${id}::uuid AND s."userId" = ${origin.userId}::uuid
        AND s."tenantId" = ${origin.tenantId}::uuid AND s."tenantMembershipId" = ${origin.tenantMembershipId}::uuid
        AND s."companyMembershipId" = ${origin.companyMembershipId}::uuid
        AND m."userId" = s."userId" AND m."tenantId" = s."tenantId"
        AND m."tenantMembershipId" = s."tenantMembershipId" AND m."companyId" = ${claims.companyId}::uuid
        ${exactHash ? Prisma.sql`AND s."tokenHash" = ${exactHash}` : Prisma.empty}
      FOR UPDATE OF s`);
    if (rows.length > 1) throw invalid();
    return rows[0];
  };
  let node = await load(origin.id, tokenHash);
  if (!node) return;
  const ids: string[] = [], seen = new Set<string>();
  let expectedDepth = node.rotationDepth;
  while (node) {
    if (seen.has(node.id) || ids.length > MAX_REFRESH_ROTATION_DEPTH || !Number.isInteger(node.rotationDepth) ||
        node.rotationDepth !== expectedDepth || node.rotationDepth < 0 || node.rotationDepth > MAX_REFRESH_ROTATION_DEPTH ||
        node.userId !== origin.userId || node.tenantId !== origin.tenantId || node.tenantMembershipId !== origin.tenantMembershipId ||
        node.companyMembershipId !== origin.companyMembershipId) throw invalid();
    seen.add(node.id); ids.push(node.id);
    if (!node.replacedBySessionId) { if (node.replacementDepth !== null) throw invalid(); break; }
    if (!node.revokedAt || node.replacementDepth !== node.rotationDepth + 1 || node.replacementDepth > MAX_REFRESH_ROTATION_DEPTH) throw invalid();
    expectedDepth = node.replacementDepth;
    node = await load(node.replacedBySessionId);
    if (!node) throw invalid();
  }
  // Validate the entire locked chain before mutating any leaf; retain published history.
  const revoked = await tx.userRefreshSession.updateMany({ where: { id: { in: ids }, userId: origin.userId,
    tenantId: origin.tenantId, tenantMembershipId: origin.tenantMembershipId, companyMembershipId: origin.companyMembershipId,
    revokedAt: null, companyMembership: where.companyMembership }, data: { revokedAt: new Date() } });
  // The lineage lock serializes competing accepted logouts. No-op retries emit no duplicate event.
  if (revoked.count > 0) await tx.credentialSecurityEvent.create({ data: { actorUserId: origin.userId,
    tenantId: origin.tenantId!, tenantMembershipId: origin.tenantMembershipId!, companyMembershipId: origin.companyMembershipId!,
    companyId: origin.companyMembership!.companyId, action: "LOGOUT_ACCEPTED" } });
}
