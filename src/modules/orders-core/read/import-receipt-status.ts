import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import { creationOperationId } from "../domain/creation-request";
import { authorityError } from "../domain/creation-authority";
import {
  requireTenantBoundOrderCompanyAuthority,
  hasCompanyScope,
} from "../domain/company-authority";
import { validateCreationReferences } from "../domain/creation-references";

/** Read accepted facts only. No acceptance, pricing, jobs or downstream recovery. */
export async function readImportReceiptStatus(
  actor: AppUser,
  operation: unknown,
) {
  const operationId = creationOperationId(operation);
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '3000ms'");
      const membership = await requireTenantBoundOrderCompanyAuthority(
        tx,
        actor,
        "shipment.create",
      );
      if (!hasCompanyScope(membership))
        throw authorityError("Company creation scope required", 403);
      const intent = await tx.orderCreationIntent.findFirst({
        where: {
          operationId,
          kind: "import",
          tenantId: actor.tenantId!,
          companyId: actor.companyId!,
          userId: actor.id,
          companyMembershipId: actor.companyMembershipId!,
          tenantMembershipId: actor.tenantMembershipId!,
        },
        select: {
          id: true,
          operationId: true,
          acceptedAt: true,
          rowCount: true,
          normalizationVersion: true,
        },
      });
      if (!intent) throw authorityError("Import receipt not found", 404);
      if (
        intent.normalizationVersion !== 1 ||
        intent.rowCount < 1 ||
        intent.rowCount > 100
      )
        throw authorityError("Unsupported import receipt", 409);
      const receipts = await tx.orderCreationReceipt.findMany({
        where: {
          intentId: intent.id,
          tenantId: actor.tenantId!,
          companyId: actor.companyId!,
        },
        orderBy: { ordinal: "asc" },
        take: 101,
        select: {
          ordinal: true,
          confirmedAt: true,
          order: {
            select: {
              id: true,
              orderNumber: true,
              tenantId: true,
              ownerOrgId: true,
              customerId: true,
              customerEntityId: true,
              senderAddressId: true,
              receiverAddressId: true,
            },
          },
        },
      });
      if (
        receipts.length > intent.rowCount ||
        receipts.some((r) => r.ordinal < 0 || r.ordinal >= intent.rowCount)
      )
        throw authorityError("Inconsistent import receipt", 409);
      for (const receipt of receipts) {
        const order = receipt.order;
        if (
          order.tenantId !== actor.tenantId ||
          order.ownerOrgId !== actor.companyId ||
          order.customerId !== actor.id
        )
          throw authorityError("Confirmed order is not accessible", 403);
        await validateCreationReferences(tx, actor, order, false);
      }
      const rows = Array.from({ length: intent.rowCount }, (_, ordinal) => {
        const receipt = receipts.find((r) => r.ordinal === ordinal);
        return receipt
          ? {
              ordinal,
              state: "committed" as const,
              confirmedAt: receipt.confirmedAt.toISOString(),
              order: {
                id: receipt.order.id,
                orderNumber: receipt.order.orderNumber,
              },
            }
          : { ordinal, state: "pending" as const };
      });
      return {
        operationId,
        kind: "import" as const,
        acceptedAt: intent.acceptedAt.toISOString(),
        rowCount: intent.rowCount,
        complete: receipts.length === intent.rowCount,
        rows,
        downstreamCompletion: "not_assessed" as const,
      };
    },
    { isolationLevel: "RepeatableRead", maxWait: 2000, timeout: 10000 },
  );
}
