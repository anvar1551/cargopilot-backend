import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import { integrationProviderContext } from "./provider-access";
import { hasCompanyScope, requireTenantBoundOrderCompanyAuthority } from "../../orders-core/domain/company-authority";
import { requireAuthorizedOrder } from "../../orders-core/domain/order-access";
import { buildMembershipOrderScopeWhere } from "../../identity-access/access-control";
import { loadAcceptedCarrierOperation } from "../../orders-legs/carrier-worker-authority";
import { publishCarrierCanonicalTx } from "../infrastructure/canonical-event.repo";
import { authorityError } from "../../orders-core/domain/creation-authority";

const deny = () => { throw Object.assign(authorityError("Sandbox publication source insufficient or conflicting", 409), { code: "SANDBOX_PUBLICATION_REPAIR_DENIED" }); };
function stable(value: any, depth = 0): any {
  if (depth > 32) deny();
  if (Array.isArray(value)) return value.map(item => stable(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key], depth + 1)]));
  return value;
}

/** Internal only: no route, scheduled caller or worker impersonation. Public reconciliation eligibility remains undecided. */
export async function repairSandboxPublicationInternal(user: AppUser, outboxId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(outboxId)) throw authorityError("Outbox UUID required", 400);
  const context = await integrationProviderContext(user, "integration.outbox.replay");
  const scoped = await prisma.integrationOutbox.findFirst({ where: { ...context, id: outboxId, ownershipTenantId: user.tenantId }, select: { ownershipOrderId: true } });
  if (!scoped?.ownershipOrderId) throw authorityError("Outbox record not found", 404);
  await requireAuthorizedOrder(user, scoped.ownershipOrderId, "shipment.bookCarrier");
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL lock_timeout = '2000ms'`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '5000ms'`;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('carrier-publication'), hashtext(${outboxId}))::text`;
    await tx.$queryRaw`SELECT id FROM "IntegrationOutbox" WHERE id=${outboxId}::uuid FOR SHARE`;
    const { row, leg } = await loadAcceptedCarrierOperation(tx, outboxId);
    if (row.ownershipTenantId !== user.tenantId || row.companyId !== user.companyId || row.ownershipOrderId !== scoped.ownershipOrderId ||
        row.providerCode !== "fake_carrier" || row.environment !== "sandbox" || row.operation !== "create_shipment" ||
        row.status !== "sent" || row.attemptCount !== 1 || !row.executionStartedAt) deny();
    const membership = await requireTenantBoundOrderCompanyAuthority(tx, user, "integration.outbox.replay");
    if (!hasCompanyScope(membership)) deny();
    await requireTenantBoundOrderCompanyAuthority(tx, user, "shipment.bookCarrier");
    const scope = await buildMembershipOrderScopeWhere(user, "shipment.bookCarrier");
    if (!scope || !await tx.order.findFirst({ where: { AND: [scope!, { id: row.ownershipOrderId, tenantId: user.tenantId!, ownerOrgId: user.companyId! }] }, select: { id: true } })) deny();
    await tx.$queryRaw`SELECT id FROM "IntegrationDeliveryAttempt" WHERE "outboxId"=${outboxId}::uuid AND "attemptNo"=1 FOR SHARE`;
    const attempt = await tx.integrationDeliveryAttempt.findFirst({ where: { outboxId }, orderBy: { attemptNo: "desc" } });
    const response = attempt?.responseJson as any;
    if (!attempt || attempt.attemptNo !== 1 || attempt.outcome !== "success" || !attempt.statusCode || attempt.statusCode < 200 || attempt.statusCode >= 300 ||
        attempt.finishedAt < attempt.startedAt || attempt.startedAt < row.executionStartedAt ||
        !response || typeof response.partnerShipmentId !== "string" || !response.partnerShipmentId.trim() || response.partnerShipmentId.length > 1024 ||
        JSON.stringify(response).length > 1024 * 1024 || (leg.carrierRef && leg.carrierRef !== response.partnerShipmentId)) deny();
    const payloadJson = { requestJson: attempt!.requestJson ?? null, responseJson: attempt!.responseJson ?? null,
      providerRequestId: attempt!.providerRequestId ?? null, statusCode: attempt!.statusCode };
    if (Buffer.byteLength(JSON.stringify(payloadJson)) > 1024 * 1024) deny();
    const fingerprint = JSON.stringify(stable(payloadJson));
    const publication = await publishCarrierCanonicalTx(tx, { source: "outbound_response", outboxId, domain: "carrier", providerCode: "fake_carrier", eventType: "carrier.shipment.created", aggregateType: "shipment", aggregateId: leg.id, payloadJson, occurredAt: attempt!.finishedAt.toISOString() });
    const resultSha256 = createHash("sha256").update(fingerprint).digest("hex");
    const previous = await tx.carrierPublicationRepair.findUnique({ where: { outboxId } });
    if (previous && (previous.tenantId !== user.tenantId || previous.companyId !== row.companyId || previous.providerId !== row.providerId || previous.attemptNo !== attempt!.attemptNo || previous.resultSha256 !== resultSha256)) deny();
    const proof = previous ?? await tx.carrierPublicationRepair.create({ data: { outboxId, tenantId: user.tenantId!, companyId: row.companyId, providerId: row.providerId, domain: "carrier", providerCode: "fake_carrier", attemptNo: 1, userId: user.id, companyMembershipId: user.companyMembershipId!, tenantMembershipId: user.tenantMembershipId!, resultSha256 } });
    return { outboxId, publicationId: publication.id, status: publication.status, recordedAt: proof.recordedAt.toISOString() };
  }, { maxWait: 2000, timeout: 10000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
