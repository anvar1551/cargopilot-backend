import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import { buildSupportScopeWhere, buildOrderScopeWhere, loadAccessSnapshot } from "../../identity-access/access-control";

export type SupportActor = AppUser;
export const supportError = (message: string, statusCode = 403) => Object.assign(new Error(message), { statusCode });

export async function requireSupportAccess(actor: SupportActor, permission = "support.view") {
  if (!actor?.id || !actor.tenantId || !actor.tenantMembershipId || !actor.companyId ||
      !actor.companyMembershipId || actor.membershipId !== actor.companyMembershipId) throw supportError("Tenant-bound support context required");
  const snapshot = await loadAccessSnapshot({ userId: actor.id, membershipId: actor.membershipId,
    companyMembershipId: actor.companyMembershipId, companyId: actor.companyId,
    tenantId: actor.tenantId, tenantMembershipId: actor.tenantMembershipId, requireFresh: true });
  if (!snapshot || snapshot.userId !== actor.id || snapshot.membershipId !== actor.membershipId ||
      snapshot.companyMembershipId !== actor.companyMembershipId || snapshot.companyId !== actor.companyId ||
      snapshot.tenantId !== actor.tenantId || snapshot.tenantMembershipId !== actor.tenantMembershipId ||
      !snapshot.permissionCodes.includes(permission)) throw supportError("Forbidden");
  const verified = { ...actor, ...snapshot, id: snapshot.userId };
  const objectScope = await buildSupportScopeWhere(verified);
  const orderScope = await buildOrderScopeWhere(verified, "shipment.view");
  if (!objectScope || !Object.keys(objectScope).length || ("id" in objectScope && objectScope.id === "__no_access__")) throw supportError("Support object scope required");
  const safeOrderScope = safeSupportOrderScope(orderScope);
  const where = { AND: [
    { tenantId: snapshot.tenantId, ownerOrgId: snapshot.companyId },
    objectScope ?? { id: "__no_access__" },
    { OR: [{ orderId: null }, { order: { is: { AND: [
      { tenantId: snapshot.tenantId, ownerOrgId: snapshot.companyId }, safeOrderScope,
    ] } } }] },
  ] };
  return { actor: verified, snapshot, where, objectScope };
}

/** Convert established denial sentinels to valid UUID predicates, including nested AND/OR. */
export function safeSupportOrderScope(scope: any): any {
  if (!scope || !Object.keys(scope).length) return { id: { in: [] } };
  const visit = (value: any): any => Array.isArray(value) ? value.map(visit) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "id" && item === "__no_access__" ? { in: [] } : visit(item)])) : value;
  return visit(scope);
}

/** Evaluates only the established support helper's scalar scope against a prospective owned row. */
export function matchesProspectiveSupportScope(scope: any, row: Record<string, unknown>): boolean {
  if (!scope || !Object.keys(scope).length) return false;
  return Object.entries(scope).every(([key, value]: [string, any]) => {
    if (key === "AND") return (Array.isArray(value) ? value : [value]).every(s => matchesProspectiveSupportScope(s, row));
    if (key === "OR") return value.some((s: any) => matchesProspectiveSupportScope(s, row));
    if (!["ownerOrgId", "assignedOrgId", "ownerId", "customerEntityId"].includes(key)) return false;
    return typeof value === "string" ? row[key] === value : Array.isArray(value?.in) && value.in.includes(row[key]);
  });
}

export function rejectSupportOwnership(input: object) {
  for (const key of ["tenantId", "tenant", "companyId", "ownerOrgId", "assignedOrgId", "ownerCompanyMembershipId", "customerUserId", "customerEntityId", "driverId", "warehouseId", "queueId"]) {
    if (Object.prototype.hasOwnProperty.call(input, key)) throw supportError("Support ownership is server controlled", 400);
  }
}

export async function supportAssignee(userId: string, actor: SupportActor, ticket?: { customerEntityId?: string | null; assignedOrgId?: string | null }, client: any = prisma) {
  const membership = await client.companyMembership.findUnique({ where: { userId_companyId: { userId, companyId: actor.companyId } },
    select: { id: true, tenantMembershipId: true } });
  if (!membership?.tenantMembershipId) throw supportError("Assignee is not eligible", 400);
  const snapshot = await loadAccessSnapshot({ userId, membershipId: membership.id, companyMembershipId: membership.id,
    companyId: actor.companyId, tenantId: actor.tenantId, tenantMembershipId: membership.tenantMembershipId, requireFresh: true });
  if (!snapshot?.permissionCodes.includes("support.update") || !snapshot.scopes.some(s =>
      ((s.scopeType === "company" || s.scopeType === "branch" || s.scopeType === "agent" || s.scopeType === "pickup_point" || s.scopeType === "carrier" || s.scopeType === "client") &&
        (s.scopeRefId === actor.companyId || (!!ticket?.assignedOrgId && s.scopeRefId === ticket.assignedOrgId))))) {
    throw supportError("Assignee lacks support scope", 400);
  }
  return { id: userId, name: snapshot.name, email: snapshot.email, membershipId: snapshot.membershipId };
}

export async function lockSupportTicket(tx: any, id: string, access: Awaited<ReturnType<typeof requireSupportAccess>>) {
  await tx.$queryRaw`SELECT "id" FROM "SupportTicket" WHERE "id" = ${id}::uuid AND "tenantId" = ${access.snapshot.tenantId}::uuid AND "ownerOrgId" = ${access.snapshot.companyId}::uuid FOR UPDATE`;
  const ticket = await tx.supportTicket.findFirst({ where: { AND: [{ id }, access.where] } });
  if (!ticket) throw supportError("Support ticket not found", 404);
  return ticket;
}
