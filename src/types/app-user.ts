export type AppScopeType =
  | "company"
  | "branch"
  | "warehouse"
  | "agent"
  | "pickup_point"
  | "carrier"
  | "client";

export type AppUser = {
  id: string;
  membershipId: string;
  companyMembershipId: string;
  companyId: string;
  tenantId: string;
  tenantMembershipId: string;
  branchId: string | null;
  email: string;
  name: string;
  warehouseId: string | null;
  customerEntityId: string | null;
  roleCodes: string[];
  permissionCodes: string[];
  scopes: Array<{
    scopeType: AppScopeType;
    scopeRefId: string;
  }>;
};
