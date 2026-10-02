import { Prisma } from "@prisma/client";
import type { AppUser } from "../../../types/app-user";
import { buildOrderScopeWhere } from "../../identity-access/access-control";
import { requireCustomerAccess } from "../../customers-core/application/customerAccess";
import { requireWarehouseAccess } from "../../warehouse-core/application/warehouseAccess";
import { requireIdentityManagementContext } from "../../identity-access/application/managementAccess";
import { financeConflict } from "../domain/finance.errors";

type Line = { orderId?: string | null; orderLegId?: string | null; customerEntityId?: string | null; warehouseId?: string | null; carrierProviderId?: string | null };
type Owner = { tenantId: string; companyId: string };
const fields = ["orderId", "orderLegId", "customerEntityId", "warehouseId", "carrierProviderId"] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reject = (): never => { throw financeConflict("Draft operational references are unavailable in the selected scope", "FINANCE_DRAFT_REFERENCE_REJECTED"); };

/** Manual drafts only. No service authority or generic finance permission bypass.
 * Locks span validation through the caller's draft/receipt transaction. Historical
 * lines and other writers still require relational enforcement; this is not backfill.
 */
export async function requireDraftOperationalReferences(tx: Prisma.TransactionClient, actor: AppUser, lines: Line[], owner: Owner) {
  if (!actor?.id || !owner.tenantId || !owner.companyId || actor.tenantId !== owner.tenantId || actor.companyId !== owner.companyId
      || !actor.tenantMembershipId || !actor.companyMembershipId || actor.membershipId !== actor.companyMembershipId || lines.length > 500) reject();
  for (const line of lines) {
    if (fields.some(key => line[key] != null && (typeof line[key] !== "string" || !uuid.test(line[key]!))) || (line.orderLegId != null && line.orderId == null)) reject();
  }
  const ids = (key: typeof fields[number]) => [...new Set(lines.flatMap(line => line[key] == null ? [] : [line[key]!]))].sort();
  const orders = ids("orderId"), legs = ids("orderLegId"), customers = ids("customerEntityId"), warehouses = ids("warehouseId"), providers = ids("carrierProviderId");
  if (![orders, legs, customers, warehouses, providers].some(group => group.length)) return;
  // Resolve actual action/scope policies before any locks or protected record reads.
  const orderScope = orders.length ? await buildOrderScopeWhere(actor, "shipment.view") : null;
  if (orders.length && (!orderScope || orderScope.id === "__no_access__")) reject();
  const customerAccess = customers.length ? await requireCustomerAccess(actor, "customers.read") : null;
  const warehouseAccess = warehouses.length ? await requireWarehouseAccess(actor, "shipment.view") : null;
  if (providers.length) await requireIdentityManagementContext(actor, "integration.provider.read");

  // Fixed server-owned identifiers, sorted IDs and fixed table order. FOR SHARE
  // blocks ownership/child retargeting and deletion, including non-key updates.
  for (const [table, group] of [["Order", orders], ["OrderLeg", legs], ["CustomerEntity", customers], ["Warehouse", warehouses], ["IntegrationProvider", providers]] as const) {
    if (group.length) await tx.$queryRaw(Prisma.sql`SELECT id FROM ${Prisma.raw('"' + table + '"')} WHERE id IN (${Prisma.join(group.map(id => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR SHARE`);
  }
  const ownedOrders = orders.length ? await tx.order.findMany({ where: { AND: [{ id: { in: orders }, tenantId: owner.tenantId, ownerOrgId: owner.companyId }, orderScope!] },
    select: { id: true, tenantId: true, ownerOrgId: true, customerEntityId: true } }) : [];
  if (ownedOrders.length !== orders.length || ownedOrders.some(row => row.tenantId !== owner.tenantId || row.ownerOrgId !== owner.companyId)) reject();
  const ownedLegs = legs.length ? await tx.orderLeg.findMany({ where: { id: { in: legs }, orderId: { in: orders } }, select: { id: true, orderId: true, carrierProviderId: true } }) : [];
  if (ownedLegs.length !== legs.length) reject();
  const ownedCustomers = customers.length ? await tx.customerEntity.findMany({ where: { AND: [{ id: { in: customers }, tenantId: owner.tenantId }, customerAccess!.customerWhere] }, select: { id: true, tenantId: true } }) : [];
  if (ownedCustomers.length !== customers.length || ownedCustomers.some(row => row.tenantId !== owner.tenantId)) reject();
  const ownedWarehouses = warehouses.length ? await tx.warehouse.findMany({ where: { AND: [{ id: { in: warehouses }, tenantId: owner.tenantId }, warehouseAccess!.where] }, select: { id: true, tenantId: true } }) : [];
  if (ownedWarehouses.length !== warehouses.length || ownedWarehouses.some(row => row.tenantId !== owner.tenantId)) reject();
  const ownedProviders = providers.length ? await tx.integrationProvider.findMany({ where: { id: { in: providers }, companyId: owner.companyId, domain: "carrier", status: "active", company: { tenantId: owner.tenantId, isActive: true, tenant: { status: "active" } } },
    select: { id: true, companyId: true, domain: true, status: true } }) : [];
  if (ownedProviders.length !== providers.length || ownedProviders.some(row => row.companyId !== owner.companyId || row.domain !== "carrier" || row.status !== "active")) reject();
  const orderMap = new Map(ownedOrders.map(row => [row.id, row])), legMap = new Map(ownedLegs.map(row => [row.id, row]));
  for (const line of lines) {
    if (line.orderLegId && legMap.get(line.orderLegId)?.orderId !== line.orderId) reject();
    if (line.orderId && line.customerEntityId && orderMap.get(line.orderId)?.customerEntityId !== line.customerEntityId) reject();
    if (line.orderLegId && line.carrierProviderId && legMap.get(line.orderLegId)?.carrierProviderId !== line.carrierProviderId) reject();
  }
}
