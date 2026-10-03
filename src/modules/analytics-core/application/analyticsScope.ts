import { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import { buildMembershipOrderScopeWhere } from "../../identity-access/access-control";
import { requireTenantBoundOrderCompanyAuthority } from "../../orders-core/domain/company-authority";

const deny = (): never => { throw Object.assign(new Error("Selected analytics permission and scope required"), { statusCode: 403 }); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const columns = new Set(["id", "tenantId", "ownerOrgId", "assignedOrgId", "currentWarehouseId", "assignedDriverId", "customerEntityId"]);

/** Restricted compiler for server-produced scope predicates, never request filters or arbitrary SQL. */
export function analyticsOrderScopeSql(where: Prisma.OrderWhereInput): Prisma.Sql {
  let nodes = 0;
  const compile = (value: any, depth: number): Prisma.Sql => {
    if (++nodes > 4096 || depth > 12 || !value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) return deny();
    const parts = Object.entries(value).map(([key, filter]): Prisma.Sql => {
      if (key === "AND" || key === "OR") {
        const values = Array.isArray(filter) ? filter : [filter];
        if (!values.length || values.length > 1000) return deny();
        return Prisma.sql`(${Prisma.join(values.map(item => compile(item, depth + 1)), key === "AND" ? " AND " : " OR ")})`;
      }
      if (!columns.has(key)) return deny();
      const column = Prisma.raw(`"o"."${key}"`);
      if (filter === "__no_access__") return Prisma.sql`FALSE`;
      if (typeof filter === "string" && uuid.test(filter)) return Prisma.sql`${column} = ${filter}::uuid`;
      if (filter && typeof filter === "object" && !Array.isArray(filter) && Object.keys(filter).join() === "in") {
        const values = (filter as any).in;
        if (!Array.isArray(values) || values.length > 1000 || values.some(item => typeof item !== "string" || !uuid.test(item))) return deny();
        return values.length ? Prisma.sql`${column} IN (${Prisma.join(values.map(item => Prisma.sql`${item}::uuid`))})` : Prisma.sql`FALSE`;
      }
      return deny();
    });
    return Prisma.sql`(${Prisma.join(parts, " AND ")})`;
  };
  return compile(where, 0);
}

export async function requireAnalyticsScope(actor: AppUser, permission = "shipment.view") {
  if (!actor?.id || !actor.tenantId || !actor.companyId || !actor.companyMembershipId || !actor.tenantMembershipId || actor.membershipId !== actor.companyMembershipId) return deny();
  await requireTenantBoundOrderCompanyAuthority(prisma, actor, permission);
  const scope = await buildMembershipOrderScopeWhere(actor, permission);
  if (!scope || !Object.keys(scope).length || JSON.stringify(scope).includes('"__no_access__"')) return deny();
  const where: Prisma.OrderWhereInput = { AND: [{ tenantId: actor.tenantId }, scope] };
  return { where, sql: analyticsOrderScopeSql(where) };
}

export async function freshAnalyticsRead<T>(build: (db: Prisma.TransactionClient) => Promise<T>) {
  const payload = await prisma.$transaction(async db => {
    await db.$executeRaw`SET TRANSACTION READ ONLY`;
    await db.$executeRaw`SET LOCAL statement_timeout = '5s'`;
    return build(db);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 2000, timeout: 10000 });
  return { payload, cacheHit: false };
}
