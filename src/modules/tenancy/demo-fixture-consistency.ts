import { DemoCompanyMembership, TenantDemoFixture } from "./demo-fixtures";

export type FixtureIssueCode =
  | "UNKNOWN_TENANT"
  | "ORGANIZATION_PARENT_TENANT_MISMATCH"
  | "CP_ROOT_TENANT_OWNERSHIP_FORBIDDEN"
  | "ADDRESS_CUSTOMER_TENANT_MISMATCH"
  | "LEGAL_ENTITY_COMPANY_TENANT_MISMATCH"
  | "TENANT_MEMBERSHIP_IDENTITY_INVALID"
  | "COMPANY_MEMBERSHIP_TENANT_MEMBERSHIP_IDENTITY_MISMATCH"
  | "COMPANY_MEMBERSHIP_COMPANY_TENANT_MISMATCH"
  | "COMPANY_MEMBERSHIP_BRANCH_TENANT_MISMATCH"
  | "ORDER_OWNER_TENANT_MISMATCH"
  | "ORDER_RELATION_TENANT_MISMATCH"
  | "ORDER_CUSTOMER_MEMBERSHIP_MISSING"
  | "INVOICE_ORDER_TENANT_MISMATCH"
  | "INVOICE_ORDER_LEGAL_ENTITY_MISMATCH"
  | "INVOICE_RELATION_MISMATCH";

export type FixtureIssue = {
  code: FixtureIssueCode;
  resourceType: string;
  resourceId: string;
  relationId?: string;
};

export function assessTenantDemoFixture(fixture: TenantDemoFixture): FixtureIssue[] {
  const issues: FixtureIssue[] = [];
  const tenantIds = new Set(fixture.tenants.map((item) => item.id));
  const users = new Map(fixture.users.map((item) => [item.id, item]));
  const organizations = new Map(fixture.organizations.map((item) => [item.id, item]));
  const tenantMemberships = new Map(fixture.tenantMemberships.map((item) => [item.id, item]));
  const warehouses = new Map(fixture.warehouses.map((item) => [item.id, item]));
  const customers = new Map(fixture.customers.map((item) => [item.id, item]));
  const addresses = new Map(fixture.addresses.map((item) => [item.id, item]));
  const orders = new Map(fixture.orders.map((item) => [item.id, item]));
  const legalEntitiesByCompany = new Map(fixture.financeLegalEntities.map((item) => [item.companyId, item]));

  const requireTenant = (resourceType: string, resourceId: string, tenantId: string) => {
    if (!tenantIds.has(tenantId)) issues.push({ code: "UNKNOWN_TENANT", resourceType, resourceId, relationId: tenantId });
  };

  fixture.organizations.forEach((organization) => {
    requireTenant("organization", organization.id, organization.tenantId);
    if (organization.code === "CP_ROOT") {
      issues.push({ code: "CP_ROOT_TENANT_OWNERSHIP_FORBIDDEN", resourceType: "organization", resourceId: organization.id });
    }
    if (organization.parentOrgId) {
      const parent = organizations.get(organization.parentOrgId);
      if (!parent || parent.tenantId !== organization.tenantId) {
        issues.push({ code: "ORGANIZATION_PARENT_TENANT_MISMATCH", resourceType: "organization", resourceId: organization.id, relationId: organization.parentOrgId });
      }
    }
  });

  fixture.warehouses.forEach((warehouse) => requireTenant("warehouse", warehouse.id, warehouse.tenantId));
  fixture.customers.forEach((customer) => requireTenant("customer", customer.id, customer.tenantId));
  fixture.addresses.forEach((address) => {
    requireTenant("address", address.id, address.tenantId);
    if (customers.get(address.customerEntityId)?.tenantId !== address.tenantId) {
      issues.push({ code: "ADDRESS_CUSTOMER_TENANT_MISMATCH", resourceType: "address", resourceId: address.id, relationId: address.customerEntityId });
    }
  });

  fixture.financeLegalEntities.forEach((legalEntity) => {
    requireTenant("financeLegalEntity", legalEntity.id, legalEntity.tenantId);
    const company = organizations.get(legalEntity.companyId);
    if (!company || company.type !== "company" || company.tenantId !== legalEntity.tenantId) {
      issues.push({ code: "LEGAL_ENTITY_COMPANY_TENANT_MISMATCH", resourceType: "financeLegalEntity", resourceId: legalEntity.id, relationId: legalEntity.companyId });
    }
  });

  fixture.tenantMemberships.forEach((membership) => {
    if (!tenantIds.has(membership.tenantId) || !users.has(membership.userId)) {
      issues.push({ code: "TENANT_MEMBERSHIP_IDENTITY_INVALID", resourceType: "tenantMembership", resourceId: membership.id });
    }
  });

  fixture.companyMemberships.forEach((membership) => {
    const tenantMembership = tenantMemberships.get(membership.tenantMembershipId);
    if (!tenantMembership || tenantMembership.userId !== membership.userId || tenantMembership.tenantId !== membership.tenantId) {
      issues.push({ code: "COMPANY_MEMBERSHIP_TENANT_MEMBERSHIP_IDENTITY_MISMATCH", resourceType: "companyMembership", resourceId: membership.id, relationId: membership.tenantMembershipId });
    }
    const company = organizations.get(membership.companyId);
    if (!company || company.type !== "company" || company.tenantId !== membership.tenantId) {
      issues.push({ code: "COMPANY_MEMBERSHIP_COMPANY_TENANT_MISMATCH", resourceType: "companyMembership", resourceId: membership.id, relationId: membership.companyId });
    }
    if (membership.branchId) {
      const branch = organizations.get(membership.branchId);
      if (!branch || branch.type !== "branch" || branch.tenantId !== membership.tenantId || branch.parentOrgId !== membership.companyId) {
        issues.push({ code: "COMPANY_MEMBERSHIP_BRANCH_TENANT_MISMATCH", resourceType: "companyMembership", resourceId: membership.id, relationId: membership.branchId });
      }
    }
  });

  fixture.orders.forEach((order) => {
    requireTenant("order", order.id, order.tenantId);
    const owner = organizations.get(order.ownerOrgId);
    if (!owner || owner.type !== "company" || owner.tenantId !== order.tenantId || legalEntitiesByCompany.get(owner.id)?.tenantId !== order.tenantId) {
      issues.push({ code: "ORDER_OWNER_TENANT_MISMATCH", resourceType: "order", resourceId: order.id, relationId: order.ownerOrgId });
    }
    const assigned = organizations.get(order.assignedOrgId);
    const warehouse = warehouses.get(order.currentWarehouseId);
    const customer = customers.get(order.customerEntityId);
    const sender = addresses.get(order.senderAddressId);
    const receiver = addresses.get(order.receiverAddressId);
    const relationsMatch = assigned?.tenantId === order.tenantId && warehouse?.tenantId === order.tenantId
      && customer?.tenantId === order.tenantId && sender?.tenantId === order.tenantId
      && receiver?.tenantId === order.tenantId && sender.customerEntityId === order.customerEntityId
      && receiver.customerEntityId === order.customerEntityId;
    if (!relationsMatch) {
      issues.push({ code: "ORDER_RELATION_TENANT_MISMATCH", resourceType: "order", resourceId: order.id });
    }
    const customerMembership = fixture.tenantMemberships.some((membership) => membership.userId === order.customerId
      && membership.tenantId === order.tenantId && membership.status === "active");
    if (!customerMembership) {
      issues.push({ code: "ORDER_CUSTOMER_MEMBERSHIP_MISSING", resourceType: "order", resourceId: order.id, relationId: order.customerId });
    }
  });

  fixture.invoices.forEach((invoice) => {
    requireTenant("invoice", invoice.id, invoice.tenantId);
    const order = orders.get(invoice.orderId);
    if (!order || order.tenantId !== invoice.tenantId) {
      issues.push({ code: "INVOICE_ORDER_TENANT_MISMATCH", resourceType: "invoice", resourceId: invoice.id, relationId: invoice.orderId });
      return;
    }
    const legalEntity = legalEntitiesByCompany.get(invoice.companyId);
    if (invoice.companyId !== order.ownerOrgId || !legalEntity || legalEntity.tenantId !== invoice.tenantId) {
      issues.push({ code: "INVOICE_ORDER_LEGAL_ENTITY_MISMATCH", resourceType: "invoice", resourceId: invoice.id, relationId: invoice.companyId });
    }
    if (invoice.customerId !== order.customerId || invoice.customerEntityId !== order.customerEntityId
      || customers.get(invoice.customerEntityId)?.tenantId !== invoice.tenantId) {
      issues.push({ code: "INVOICE_RELATION_MISMATCH", resourceType: "invoice", resourceId: invoice.id });
    }
  });

  return issues;
}

/** Resolves only an explicitly selected active membership for the authenticated user. */
export function resolveExplicitCompanyMembership(
  fixture: TenantDemoFixture,
  userId: string,
  companyMembershipId: string,
): DemoCompanyMembership {
  const membership = fixture.companyMemberships.find((item) => item.id === companyMembershipId);
  if (!membership || membership.userId !== userId || membership.status !== "active") {
    throw new Error("Explicit authorized company membership is required");
  }
  const tenantMembership = fixture.tenantMemberships.find((item) => item.id === membership.tenantMembershipId);
  if (!tenantMembership || tenantMembership.userId !== userId || tenantMembership.tenantId !== membership.tenantId
    || tenantMembership.status !== "active") {
    throw new Error("Company membership is not linked to the active tenant membership");
  }
  return membership;
}
