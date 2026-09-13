export type DemoTenant = { id: string; code: string; name: string };
export type DemoUser = { id: string; email: string; name: string };
export type DemoOrganization = {
  id: string;
  tenantId: string;
  type: "company" | "branch";
  code: string;
  name: string;
  parentOrgId: string | null;
};
export type DemoTenantMembership = {
  id: string;
  tenantId: string;
  userId: string;
  status: "active";
};
export type DemoCompanyMembership = {
  id: string;
  tenantId: string;
  tenantMembershipId: string;
  userId: string;
  companyId: string;
  branchId: string | null;
  status: "active";
  roleCodes: string[];
};
export type DemoWarehouse = { id: string; tenantId: string; name: string };
export type DemoCustomer = { id: string; tenantId: string; name: string };
export type DemoAddress = {
  id: string;
  tenantId: string;
  customerEntityId: string;
  label: string;
};
export type DemoFinanceLegalEntity = {
  id: string;
  tenantId: string;
  companyId: string;
  name: string;
  baseCurrency: string;
};
export type DemoOrder = {
  id: string;
  tenantId: string;
  orderNumber: string;
  ownerOrgId: string;
  assignedOrgId: string;
  currentWarehouseId: string;
  customerId: string;
  customerEntityId: string;
  senderAddressId: string;
  receiverAddressId: string;
};
export type DemoInvoice = {
  id: string;
  tenantId: string;
  invoiceNumber: string;
  orderId: string;
  companyId: string;
  customerId: string;
  customerEntityId: string;
  amount: string;
  currency: string;
};

export type TenantDemoFixture = {
  tenants: DemoTenant[];
  users: DemoUser[];
  organizations: DemoOrganization[];
  tenantMemberships: DemoTenantMembership[];
  companyMemberships: DemoCompanyMembership[];
  warehouses: DemoWarehouse[];
  customers: DemoCustomer[];
  addresses: DemoAddress[];
  financeLegalEntities: DemoFinanceLegalEntity[];
  orders: DemoOrder[];
  invoices: DemoInvoice[];
};

export const TENANT_DEMO_IDS = {
  tenants: {
    transAsia: "019b0000-0000-7000-8000-000000000001",
    unrelated: "019b0000-0000-7000-8000-000000000002",
  },
  users: {
    multiTenant: "019b0000-0000-7000-8100-000000000001",
    maker: "019b0000-0000-7000-8100-000000000002",
    checker: "019b0000-0000-7000-8100-000000000003",
  },
  organizations: {
    transAsiaUz: "019b0000-0000-7000-8200-000000000001",
    transAsiaDe: "019b0000-0000-7000-8200-000000000002",
    transAsiaUzBranch: "019b0000-0000-7000-8200-000000000003",
    unrelated: "019b0000-0000-7000-8200-000000000004",
  },
  warehouses: {
    transAsiaUz: "019b0000-0000-7000-8300-000000000001",
    transAsiaDe: "019b0000-0000-7000-8300-000000000002",
    unrelated: "019b0000-0000-7000-8300-000000000003",
  },
  customers: {
    transAsia: "019b0000-0000-7000-8400-000000000001",
    unrelated: "019b0000-0000-7000-8400-000000000002",
  },
  addresses: {
    transAsiaSender: "019b0000-0000-7000-8500-000000000001",
    transAsiaReceiver: "019b0000-0000-7000-8500-000000000002",
    unrelatedSender: "019b0000-0000-7000-8500-000000000003",
    unrelatedReceiver: "019b0000-0000-7000-8500-000000000004",
  },
  tenantMemberships: {
    multiTransAsia: "019b0000-0000-7000-8600-000000000001",
    multiUnrelated: "019b0000-0000-7000-8600-000000000002",
    makerTransAsia: "019b0000-0000-7000-8600-000000000003",
    checkerTransAsia: "019b0000-0000-7000-8600-000000000004",
  },
  companyMemberships: {
    multiTransAsiaUz: "019b0000-0000-7000-8700-000000000001",
    multiTransAsiaDe: "019b0000-0000-7000-8700-000000000002",
    multiUnrelated: "019b0000-0000-7000-8700-000000000003",
    makerTransAsiaUz: "019b0000-0000-7000-8700-000000000004",
    checkerTransAsiaUz: "019b0000-0000-7000-8700-000000000005",
  },
  legalEntities: {
    transAsiaUz: "019b0000-0000-7000-8800-000000000001",
    transAsiaDe: "019b0000-0000-7000-8800-000000000002",
    unrelated: "019b0000-0000-7000-8800-000000000003",
  },
  orders: {
    transAsiaUz: "019b0000-0000-7000-8900-000000000001",
    transAsiaDe: "019b0000-0000-7000-8900-000000000002",
    unrelated: "019b0000-0000-7000-8900-000000000003",
  },
  invoices: {
    transAsiaUz: "019b0000-0000-7000-8a00-000000000001",
    transAsiaDe: "019b0000-0000-7000-8a00-000000000002",
    unrelated: "019b0000-0000-7000-8a00-000000000003",
  },
} as const;

// These legal entities are synthetic test examples and make no claim about
// TransAsia's actual corporate or legal structure.
const FIXTURE: TenantDemoFixture = {
  tenants: [
    { id: TENANT_DEMO_IDS.tenants.transAsia, code: "TRANSASIA_DEMO", name: "TransAsia Synthetic Demo Tenant" },
    { id: TENANT_DEMO_IDS.tenants.unrelated, code: "UNRELATED_DEMO", name: "Unrelated Synthetic Demo Tenant" },
  ],
  users: [
    { id: TENANT_DEMO_IDS.users.multiTenant, email: "multi-tenant@example.invalid", name: "Synthetic Multi-Tenant User" },
    { id: TENANT_DEMO_IDS.users.maker, email: "maker@example.invalid", name: "Synthetic Finance Maker" },
    { id: TENANT_DEMO_IDS.users.checker, email: "checker@example.invalid", name: "Synthetic Finance Checker" },
  ],
  organizations: [
    { id: TENANT_DEMO_IDS.organizations.transAsiaUz, tenantId: TENANT_DEMO_IDS.tenants.transAsia, type: "company", code: "TA_DEMO_UZ", name: "TransAsia Demo Uzbekistan Legal Entity", parentOrgId: null },
    { id: TENANT_DEMO_IDS.organizations.transAsiaDe, tenantId: TENANT_DEMO_IDS.tenants.transAsia, type: "company", code: "TA_DEMO_DE", name: "TransAsia Demo Germany Legal Entity", parentOrgId: null },
    { id: TENANT_DEMO_IDS.organizations.transAsiaUzBranch, tenantId: TENANT_DEMO_IDS.tenants.transAsia, type: "branch", code: "TA_DEMO_UZ_BRANCH", name: "TransAsia Synthetic Operations Branch", parentOrgId: TENANT_DEMO_IDS.organizations.transAsiaUz },
    { id: TENANT_DEMO_IDS.organizations.unrelated, tenantId: TENANT_DEMO_IDS.tenants.unrelated, type: "company", code: "UNRELATED_DEMO_CO", name: "Unrelated Synthetic Company", parentOrgId: null },
  ],
  tenantMemberships: [
    { id: TENANT_DEMO_IDS.tenantMemberships.multiTransAsia, tenantId: TENANT_DEMO_IDS.tenants.transAsia, userId: TENANT_DEMO_IDS.users.multiTenant, status: "active" },
    { id: TENANT_DEMO_IDS.tenantMemberships.multiUnrelated, tenantId: TENANT_DEMO_IDS.tenants.unrelated, userId: TENANT_DEMO_IDS.users.multiTenant, status: "active" },
    { id: TENANT_DEMO_IDS.tenantMemberships.makerTransAsia, tenantId: TENANT_DEMO_IDS.tenants.transAsia, userId: TENANT_DEMO_IDS.users.maker, status: "active" },
    { id: TENANT_DEMO_IDS.tenantMemberships.checkerTransAsia, tenantId: TENANT_DEMO_IDS.tenants.transAsia, userId: TENANT_DEMO_IDS.users.checker, status: "active" },
  ],
  companyMemberships: [
    { id: TENANT_DEMO_IDS.companyMemberships.multiTransAsiaUz, tenantId: TENANT_DEMO_IDS.tenants.transAsia, tenantMembershipId: TENANT_DEMO_IDS.tenantMemberships.multiTransAsia, userId: TENANT_DEMO_IDS.users.multiTenant, companyId: TENANT_DEMO_IDS.organizations.transAsiaUz, branchId: TENANT_DEMO_IDS.organizations.transAsiaUzBranch, status: "active", roleCodes: ["operations_user"] },
    { id: TENANT_DEMO_IDS.companyMemberships.multiTransAsiaDe, tenantId: TENANT_DEMO_IDS.tenants.transAsia, tenantMembershipId: TENANT_DEMO_IDS.tenantMemberships.multiTransAsia, userId: TENANT_DEMO_IDS.users.multiTenant, companyId: TENANT_DEMO_IDS.organizations.transAsiaDe, branchId: null, status: "active", roleCodes: ["operations_user"] },
    { id: TENANT_DEMO_IDS.companyMemberships.multiUnrelated, tenantId: TENANT_DEMO_IDS.tenants.unrelated, tenantMembershipId: TENANT_DEMO_IDS.tenantMemberships.multiUnrelated, userId: TENANT_DEMO_IDS.users.multiTenant, companyId: TENANT_DEMO_IDS.organizations.unrelated, branchId: null, status: "active", roleCodes: ["operations_user"] },
    { id: TENANT_DEMO_IDS.companyMemberships.makerTransAsiaUz, tenantId: TENANT_DEMO_IDS.tenants.transAsia, tenantMembershipId: TENANT_DEMO_IDS.tenantMemberships.makerTransAsia, userId: TENANT_DEMO_IDS.users.maker, companyId: TENANT_DEMO_IDS.organizations.transAsiaUz, branchId: null, status: "active", roleCodes: ["finance_maker"] },
    { id: TENANT_DEMO_IDS.companyMemberships.checkerTransAsiaUz, tenantId: TENANT_DEMO_IDS.tenants.transAsia, tenantMembershipId: TENANT_DEMO_IDS.tenantMemberships.checkerTransAsia, userId: TENANT_DEMO_IDS.users.checker, companyId: TENANT_DEMO_IDS.organizations.transAsiaUz, branchId: null, status: "active", roleCodes: ["finance_checker"] },
  ],
  warehouses: [
    { id: TENANT_DEMO_IDS.warehouses.transAsiaUz, tenantId: TENANT_DEMO_IDS.tenants.transAsia, name: "TransAsia Synthetic Tashkent Warehouse" },
    { id: TENANT_DEMO_IDS.warehouses.transAsiaDe, tenantId: TENANT_DEMO_IDS.tenants.transAsia, name: "TransAsia Synthetic Hamburg Warehouse" },
    { id: TENANT_DEMO_IDS.warehouses.unrelated, tenantId: TENANT_DEMO_IDS.tenants.unrelated, name: "Unrelated Synthetic Warehouse" },
  ],
  customers: [
    { id: TENANT_DEMO_IDS.customers.transAsia, tenantId: TENANT_DEMO_IDS.tenants.transAsia, name: "TransAsia Synthetic Customer" },
    { id: TENANT_DEMO_IDS.customers.unrelated, tenantId: TENANT_DEMO_IDS.tenants.unrelated, name: "Unrelated Synthetic Customer" },
  ],
  addresses: [
    { id: TENANT_DEMO_IDS.addresses.transAsiaSender, tenantId: TENANT_DEMO_IDS.tenants.transAsia, customerEntityId: TENANT_DEMO_IDS.customers.transAsia, label: "TransAsia Synthetic Sender" },
    { id: TENANT_DEMO_IDS.addresses.transAsiaReceiver, tenantId: TENANT_DEMO_IDS.tenants.transAsia, customerEntityId: TENANT_DEMO_IDS.customers.transAsia, label: "TransAsia Synthetic Receiver" },
    { id: TENANT_DEMO_IDS.addresses.unrelatedSender, tenantId: TENANT_DEMO_IDS.tenants.unrelated, customerEntityId: TENANT_DEMO_IDS.customers.unrelated, label: "Unrelated Synthetic Sender" },
    { id: TENANT_DEMO_IDS.addresses.unrelatedReceiver, tenantId: TENANT_DEMO_IDS.tenants.unrelated, customerEntityId: TENANT_DEMO_IDS.customers.unrelated, label: "Unrelated Synthetic Receiver" },
  ],
  financeLegalEntities: [
    { id: TENANT_DEMO_IDS.legalEntities.transAsiaUz, tenantId: TENANT_DEMO_IDS.tenants.transAsia, companyId: TENANT_DEMO_IDS.organizations.transAsiaUz, name: "TransAsia Demo Uzbekistan Legal Entity", baseCurrency: "UZS" },
    { id: TENANT_DEMO_IDS.legalEntities.transAsiaDe, tenantId: TENANT_DEMO_IDS.tenants.transAsia, companyId: TENANT_DEMO_IDS.organizations.transAsiaDe, name: "TransAsia Demo Germany Legal Entity", baseCurrency: "EUR" },
    { id: TENANT_DEMO_IDS.legalEntities.unrelated, tenantId: TENANT_DEMO_IDS.tenants.unrelated, companyId: TENANT_DEMO_IDS.organizations.unrelated, name: "Unrelated Synthetic Legal Entity", baseCurrency: "USD" },
  ],
  orders: [
    { id: TENANT_DEMO_IDS.orders.transAsiaUz, tenantId: TENANT_DEMO_IDS.tenants.transAsia, orderNumber: "TA-DEMO-UZ-0001", ownerOrgId: TENANT_DEMO_IDS.organizations.transAsiaUz, assignedOrgId: TENANT_DEMO_IDS.organizations.transAsiaUzBranch, currentWarehouseId: TENANT_DEMO_IDS.warehouses.transAsiaUz, customerId: TENANT_DEMO_IDS.users.multiTenant, customerEntityId: TENANT_DEMO_IDS.customers.transAsia, senderAddressId: TENANT_DEMO_IDS.addresses.transAsiaSender, receiverAddressId: TENANT_DEMO_IDS.addresses.transAsiaReceiver },
    { id: TENANT_DEMO_IDS.orders.transAsiaDe, tenantId: TENANT_DEMO_IDS.tenants.transAsia, orderNumber: "TA-DEMO-DE-0001", ownerOrgId: TENANT_DEMO_IDS.organizations.transAsiaDe, assignedOrgId: TENANT_DEMO_IDS.organizations.transAsiaDe, currentWarehouseId: TENANT_DEMO_IDS.warehouses.transAsiaDe, customerId: TENANT_DEMO_IDS.users.multiTenant, customerEntityId: TENANT_DEMO_IDS.customers.transAsia, senderAddressId: TENANT_DEMO_IDS.addresses.transAsiaSender, receiverAddressId: TENANT_DEMO_IDS.addresses.transAsiaReceiver },
    { id: TENANT_DEMO_IDS.orders.unrelated, tenantId: TENANT_DEMO_IDS.tenants.unrelated, orderNumber: "UNRELATED-DEMO-0001", ownerOrgId: TENANT_DEMO_IDS.organizations.unrelated, assignedOrgId: TENANT_DEMO_IDS.organizations.unrelated, currentWarehouseId: TENANT_DEMO_IDS.warehouses.unrelated, customerId: TENANT_DEMO_IDS.users.multiTenant, customerEntityId: TENANT_DEMO_IDS.customers.unrelated, senderAddressId: TENANT_DEMO_IDS.addresses.unrelatedSender, receiverAddressId: TENANT_DEMO_IDS.addresses.unrelatedReceiver },
  ],
  invoices: [
    { id: TENANT_DEMO_IDS.invoices.transAsiaUz, tenantId: TENANT_DEMO_IDS.tenants.transAsia, invoiceNumber: "TA-DEMO-UZ-INV-0001", orderId: TENANT_DEMO_IDS.orders.transAsiaUz, companyId: TENANT_DEMO_IDS.organizations.transAsiaUz, customerId: TENANT_DEMO_IDS.users.multiTenant, customerEntityId: TENANT_DEMO_IDS.customers.transAsia, amount: "125000.00", currency: "UZS" },
    { id: TENANT_DEMO_IDS.invoices.transAsiaDe, tenantId: TENANT_DEMO_IDS.tenants.transAsia, invoiceNumber: "TA-DEMO-DE-INV-0001", orderId: TENANT_DEMO_IDS.orders.transAsiaDe, companyId: TENANT_DEMO_IDS.organizations.transAsiaDe, customerId: TENANT_DEMO_IDS.users.multiTenant, customerEntityId: TENANT_DEMO_IDS.customers.transAsia, amount: "450.75", currency: "EUR" },
    { id: TENANT_DEMO_IDS.invoices.unrelated, tenantId: TENANT_DEMO_IDS.tenants.unrelated, invoiceNumber: "UNRELATED-DEMO-INV-0001", orderId: TENANT_DEMO_IDS.orders.unrelated, companyId: TENANT_DEMO_IDS.organizations.unrelated, customerId: TENANT_DEMO_IDS.users.multiTenant, customerEntityId: TENANT_DEMO_IDS.customers.unrelated, amount: "90.00", currency: "USD" },
  ],
};

/** Returns fresh, deterministic data. This module contains no persistence adapter. */
export function createTenantDemoFixture(): TenantDemoFixture {
  return JSON.parse(JSON.stringify(FIXTURE)) as TenantDemoFixture;
}
