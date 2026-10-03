import { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type { AccessTokenPayload } from "../types";
import { MAX_REFRESH_ROTATION_DEPTH } from "./refresh-lineage";

export type BoundAccessSession = AccessTokenPayload & { exp: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let inFlight = 0;
const MAX_ACCESS_READS = 32;
export function isBoundAccessSession(value: unknown): value is BoundAccessSession {
  const c = value as BoundAccessSession | null;
  return !!c && c.tokenType === "access" && c.membershipId === c.companyMembershipId &&
    [c.id, c.sid, c.membershipId, c.companyMembershipId, c.companyId, c.tenantId, c.tenantMembershipId]
      .every(id => typeof id === "string" && uuid.test(id)) &&
    Number.isSafeInteger(c.exp) && c.exp * 1000 > Date.now();
}
type Row = { id: string; userId: string; tenantId: string | null; tenantMembershipId: string | null;
  companyMembershipId: string | null; rotationDepth: number; replacementDepth: number | null;
  replacedBySessionId: string | null; revokedAt: Date | null; expiresAt: Date; hop: number };

/** Caller supplies only cryptographically verified claims. No tokens/hashes are read or logged. */
export async function hasLiveAccessSession(claims: BoundAccessSession): Promise<boolean> {
  if (!isBoundAccessSession(claims)) return false;
  if (inFlight >= MAX_ACCESS_READS) return false;
  inFlight++;
  try { return await prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
    const rows = await tx.$queryRaw<Row[]>(Prisma.sql`
      WITH RECURSIVE chain AS (
        SELECT s.id, s."userId", s."tenantId", s."tenantMembershipId", s."companyMembershipId",
          s."rotationDepth", s."replacementDepth", s."replacedBySessionId", s."revokedAt", s."expiresAt", 0 AS hop
        FROM "UserRefreshSession" s
        JOIN "CompanyMembership" m ON m.id=s."companyMembershipId" AND m."userId"=s."userId"
          AND m."tenantId"=s."tenantId" AND m."tenantMembershipId"=s."tenantMembershipId"
        JOIN "TenantMembership" tm ON tm.id=m."tenantMembershipId" AND tm."tenantId"=m."tenantId" AND tm."userId"=m."userId"
        JOIN "Tenant" t ON t.id=m."tenantId"
        JOIN "Organization" o ON o.id=m."companyId" AND o."tenantId"=t.id
        WHERE s.id=${claims.sid}::uuid AND s."userId"=${claims.id}::uuid
          AND s."tenantId"=${claims.tenantId}::uuid AND s."tenantMembershipId"=${claims.tenantMembershipId}::uuid
          AND s."companyMembershipId"=${claims.companyMembershipId}::uuid AND m."companyId"=${claims.companyId}::uuid
          AND m.status='active' AND tm.status='active' AND t.status='active' AND o."isActive"=true
        UNION ALL
        SELECT s.id, s."userId", s."tenantId", s."tenantMembershipId", s."companyMembershipId",
          s."rotationDepth", s."replacementDepth", s."replacedBySessionId", s."revokedAt", s."expiresAt", p.hop+1
        FROM chain p JOIN "UserRefreshSession" s ON s.id=p."replacedBySessionId"
          AND s."userId"=p."userId" AND s."tenantId"=p."tenantId"
          AND s."tenantMembershipId"=p."tenantMembershipId" AND s."companyMembershipId"=p."companyMembershipId"
        WHERE p.hop < ${MAX_REFRESH_ROTATION_DEPTH}
      ) SELECT * FROM chain ORDER BY hop`);
    if (!rows.length || rows.length > MAX_REFRESH_ROTATION_DEPTH + 1) return false;
    const seen = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], next = rows[i + 1];
      if (seen.has(r.id) || r.hop !== i || r.userId !== claims.id || r.tenantId !== claims.tenantId ||
          r.tenantMembershipId !== claims.tenantMembershipId || r.companyMembershipId !== claims.companyMembershipId ||
          !Number.isInteger(r.rotationDepth) || r.rotationDepth < 0 || r.rotationDepth > MAX_REFRESH_ROTATION_DEPTH) return false;
      seen.add(r.id);
      if (i === 0 && r.id !== claims.sid) return false;
      if (next) {
        if (!r.revokedAt || r.replacedBySessionId !== next.id || r.replacementDepth !== r.rotationDepth + 1 || next.rotationDepth !== r.replacementDepth) return false;
      } else if (r.replacedBySessionId || r.replacementDepth !== null || r.revokedAt || !(r.expiresAt instanceof Date) || r.expiresAt.getTime() <= Date.now()) return false;
    }
    return isBoundAccessSession(claims);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 2000, timeout: 10000 });
  } finally { inFlight--; }
}
