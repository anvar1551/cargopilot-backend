import { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import { buildMembershipOrderScopeWhere } from "../../identity-access/access-control";
import { requireAuthorizedOrder } from "../domain/order-access";
import { orderError, type OrderActor } from "../shared/actor";

export type RecoverySection = "creation" | "pricing" | "labels" | "carrier";
export type EvidenceState = "confirmed_completion" | "pending_work" | "confirmed_failure" | "uncertain_external_outcome" | "insufficient_evidence";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const evidence = (state: EvidenceState, basis: string) => ({ state, basis });

/** Durable local processing facts only. Neither a timeout nor a failed attempt proves external failure. */
export function labelEvidence(job: { status: string; attempts: number }, missing: number, parcels: number) {
  if (job.status === "completed") return parcels > 0 && missing === 0
    ? evidence("confirmed_completion", "job_complete_and_database_label_references_present")
    : evidence("insufficient_evidence", "completed_job_without_complete_label_references");
  if (job.attempts > 0 || job.status === "processing") return evidence("uncertain_external_outcome", "storage_may_precede_database_confirmation");
  if (job.status === "failed") return evidence("confirmed_failure", "local_job_failed_without_claimed_attempt");
  return evidence("pending_work", "accepted_unattempted_job");
}

export function carrierEvidence(row: { status: string; operation: string | null; executionStartedAt: Date | null; attemptCount: number }, applied: boolean) {
  if (applied) return evidence("confirmed_completion", "canonical_application_and_matching_booking_state");
  if (row.executionStartedAt || row.attemptCount > 0 || row.status === "sent") return evidence("uncertain_external_outcome", "admitted_or_attempted_without_confirmed_application");
  if (row.status === "failed" || row.status === "dead_letter") return evidence("confirmed_failure", "local_delivery_failed_without_admission_or_attempt");
  return evidence("pending_work", "accepted_unattempted_command");
}

export async function readDownstreamRecovery(actor: OrderActor, orderId: string, input: { section?: unknown; limit?: unknown; cursor?: unknown } = {}) {
  const section = input.section ?? "creation";
  const limit = input.limit === undefined ? 25 : Number(input.limit);
  const cursor = input.cursor === undefined ? undefined : String(input.cursor);
  if (!uuid.test(orderId) || typeof section !== "string" || !["creation", "pricing", "labels", "carrier"].includes(String(section)) ||
      !Number.isInteger(limit) || limit < 1 || limit > 50 || (cursor !== undefined && !uuid.test(cursor))) throw orderError("Invalid recovery page", 400);
  const authorized = await requireAuthorizedOrder(actor, orderId, "shipment.view");
  // Recovery diagnostics expose owning-company internals, not delegated dispatch-company authority.
  if (authorized.ownerOrgId !== actor.companyId) throw orderError("Order not found", 404);
  const scope = await buildMembershipOrderScopeWhere(actor as AppUser, "shipment.view");
  if (!scope || scope.id === "__no_access__" || JSON.stringify(scope).includes('"__no_access__"')) throw orderError("Order scope required", 403);
  const orderWhere: Prisma.OrderWhereInput = { AND: [scope, { id: orderId, tenantId: actor.tenantId!, ownerOrgId: actor.companyId! }] };
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
    if (!await tx.order.findFirst({ where: orderWhere, select: { id: true } })) throw orderError("Order not found", 404);
    const page = <T extends { id: string }>(rows: T[]) => ({ items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null });
    const seek = cursor ? { id: { gt: cursor } } : {};
    if (section === "creation") {
      if (cursor) throw orderError("Creation receipt is not paginated", 400);
      const receipt = await tx.orderCreationReceipt.findFirst({
        where: { orderId, tenantId: actor.tenantId!, companyId: actor.companyId!, order: orderWhere,
          intent: { userId: actor.id, companyMembershipId: actor.companyMembershipId!, tenantMembershipId: actor.tenantMembershipId! } },
        select: { ordinal: true, confirmedAt: true, intentId: true, intent: { select: { operationId: true, kind: true, rowCount: true } } },
      });
      if (!receipt) return { orderId, section, ...evidence("insufficient_evidence", "no_receipt_visible_in_exact_initiating_context"), items: [], nextCursor: null };
      const visibleConfirmedRows = await tx.orderCreationReceipt.count({ where: { intentId: receipt.intentId, tenantId: actor.tenantId!, companyId: actor.companyId!, order: { AND: [scope, { tenantId: actor.tenantId!, ownerOrgId: actor.companyId! }] } } });
      return { orderId, section, ...evidence("confirmed_completion", "order_row_receipt_only"), items: [{ operationId: receipt.intent.operationId, kind: receipt.intent.kind, ordinal: receipt.ordinal, confirmedAt: receipt.confirmedAt, acceptedRows: receipt.intent.rowCount, visibleConfirmedRows,
        batchEvidence: visibleConfirmedRows === receipt.intent.rowCount ? "confirmed_completion" : "insufficient_evidence" }], nextCursor: null };
    }
    if (section === "pricing") {
      const rows = await tx.pricingComponent.findMany({ where: { orderId, order: orderWhere, ...seek }, orderBy: { id: "asc" }, take: limit + 1,
        select: { id: true, orderLegId: true, componentType: true, source: true, createdAt: true } });
      return { orderId, section, ...evidence("insufficient_evidence", "components_do_not_certify_seed_or_financial_acceptance"), ...page(rows) };
    }
    if (section === "labels") {
      const rows = await tx.orderLabelJob.findMany({ where: { orderId, order: orderWhere, ownershipTenantId: actor.tenantId!, ownershipCompanyId: actor.companyId!, acceptedAt: { not: null }, capability: "label.generate", ...seek }, orderBy: { id: "asc" }, take: limit + 1,
        select: { id: true, status: true, attempts: true, maxAttempts: true, availableAt: true, lockedAt: true } });
      const parcels = await tx.parcel.count({ where: { orderId, order: orderWhere } });
      const missing = await tx.parcel.count({ where: { orderId, order: orderWhere, OR: [{ labelKey: null }, { labelKey: "" }] } });
      return { orderId, section, ...evidence("insufficient_evidence", "no_external_storage_verification"), ...page(rows.map(row => ({ ...row, evidence: labelEvidence(row, missing, parcels) }))) };
    }
    const rows = await tx.integrationOutbox.findMany({ where: { ownershipOrderId: orderId, ownershipTenantId: actor.tenantId!, companyId: actor.companyId!, ownedOrder: orderWhere,
      domain: "carrier", acceptedAt: { not: null }, aggregateType: "shipment", operation: { in: ["create_shipment", "cancel_shipment", "track"] }, ...seek }, orderBy: { id: "asc" }, take: limit + 1,
      select: { id: true, aggregateId: true, providerId: true, operation: true, status: true, attemptCount: true, executionStartedAt: true, nextAttemptAt: true,
        provider: { select: { id: true, companyId: true, company: { select: { tenantId: true } } } },
        canonicalEvent: { select: { source: true, companyId: true, providerId: true, domain: true, outboxId: true, status: true, processedAt: true, aggregateId: true } } } });
    const legIds = rows.map(row => row.aggregateId).filter((id): id is string => typeof id === "string" && uuid.test(id));
    const legs = await tx.orderLeg.findMany({ where: { id: { in: legIds }, orderId, order: orderWhere }, select: { id: true, carrierProviderId: true, carrierBookingStatus: true } });
    return { orderId, section, ...evidence("insufficient_evidence", "external_provider_outcomes_not_independently_verified"), ...page(rows.map(row => {
      const leg = legs.find(item => item.id === row.aggregateId);
      const bound = leg && row.providerId && leg.carrierProviderId === row.providerId && row.provider && row.provider.companyId === actor.companyId && row.provider.company.tenantId === actor.tenantId;
      const applied = !!bound && row.status === "sent" && row.canonicalEvent?.source === "outbound_response" && row.canonicalEvent.companyId === actor.companyId && row.canonicalEvent.providerId === row.providerId && row.canonicalEvent.domain === "carrier" && row.canonicalEvent.outboxId === row.id && row.canonicalEvent.status === "processed" && !!row.canonicalEvent.processedAt && row.canonicalEvent.aggregateId === leg!.id &&
        (row.operation === "track" || (row.operation === "create_shipment" && leg!.carrierBookingStatus === "booked") || (row.operation === "cancel_shipment" && leg!.carrierBookingStatus === "cancelled"));
      return { id: row.id, legId: bound ? leg!.id : null, operation: row.operation, status: row.status, attemptCount: row.attemptCount, nextAttemptAt: row.nextAttemptAt,
        evidence: bound ? carrierEvidence(row, applied) : evidence("insufficient_evidence", "booking_provider_or_child_binding_unproven") };
    })) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 2000, timeout: 10000 });
}
