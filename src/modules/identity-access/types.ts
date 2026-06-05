export type ScopeItem = {
  scopeType:
    | "company"
    | "branch"
    | "warehouse"
    | "agent"
    | "pickup_point"
    | "carrier"
    | "client";
  scopeRefId: string;
};

export type AccessSnapshot = {
  userId: string;
  membershipId: string;
  companyId: string;
  branchId: string | null;
  warehouseId: string | null;
  customerEntityId: string | null;
  email: string;
  name: string;
  roleCodes: string[];
  permissionCodes: string[];
  scopes: ScopeItem[];
};

export type AccessTokenPayload = {
  id: string;
  membershipId: string;
  companyId: string;
  branchId?: string | null;
  tokenType: "access";
};

export type RefreshTokenPayload = {
  id: string;
  sid: string;
  tokenType: "refresh";
};
