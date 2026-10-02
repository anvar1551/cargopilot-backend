import type { Prisma } from "@prisma/client";

/** Whole-journal visibility: no partial financial document or guessed legacy owner. */
export function journalDimensionOwnership(owner: { tenantId: string; companyId: string }, entityId: string): Prisma.FinanceJournalLineWhereInput {
  const order = { tenantId: owner.tenantId, ownerOrgId: owner.companyId };
  return { branchId: null, costCenterCode: null, profitCenterCode: null, AND: [
    { OR: [
      { tenantId: null, companyId: null, orderId: null, orderLegId: null, customerEntityId: null, warehouseId: null, carrierProviderId: null },
      { tenantId: owner.tenantId, companyId: owner.companyId, dimensionEntity: { is: { id: entityId, tenantId: owner.tenantId, companyId: owner.companyId } } },
    ] },
    { OR: [{ orderId: null }, { dimensionOrder: { is: order } }] },
    { OR: [{ orderLegId: null }, { orderId: { not: null }, dimensionLeg: { is: { order: { is: order } } } }] },
    { OR: [{ customerEntityId: null }, { dimensionCustomer: { is: { tenantId: owner.tenantId } } }] },
    { OR: [{ warehouseId: null }, { dimensionWarehouse: { is: { tenantId: owner.tenantId } } }] },
    { OR: [{ carrierProviderId: null }, { dimensionProvider: { is: { companyId: owner.companyId, domain: "carrier", status: "active", company: { is: { tenantId: owner.tenantId, isActive: true, tenant: { is: { status: "active" } } } } } } }] },
    { OR: [{ orderId: null }, { customerEntityId: null }, { dimensionOrderCustomer: { is: order } }] },
    { OR: [{ orderLegId: null }, { carrierProviderId: null }, { dimensionLegProvider: { is: { order: { is: order } } } }] },
  ] };
}
