export {};

declare global {
  namespace Express {
    interface User {
      id: string;
      membershipId: string;
      companyId: string;
      branchId: string | null;
      email: string;
      name: string;
      warehouseId: string | null;
      customerEntityId: string | null;
      roleCodes: string[];
      permissionCodes: string[];
      scopes: Array<{
        scopeType:
          | "company"
          | "branch"
          | "warehouse"
          | "agent"
          | "pickup_point"
          | "carrier"
          | "client";
        scopeRefId: string;
      }>;
    }
  }
}
