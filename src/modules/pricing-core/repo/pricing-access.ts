import type { AppUser } from "../../../types/app-user";
import { loadAccessSnapshot } from "../../identity-access/access-control";

export type PricingAccessContext = AppUser;

export function pricingAccessError(message: string, statusCode = 403) {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

export async function requirePricingAccess(
  input: PricingAccessContext,
  permission: "pricing.read" | "pricing.write" | "shipment.create",
) {
  const expected = {
    userId: String(input?.id ?? "").trim(),
    membershipId: String(input?.membershipId ?? "").trim(),
    companyMembershipId: String(input?.companyMembershipId ?? "").trim(),
    companyId: String(input?.companyId ?? "").trim(),
    tenantId: String(input?.tenantId ?? "").trim(),
    tenantMembershipId: String(input?.tenantMembershipId ?? "").trim(),
  };
  if (!expected.userId || !expected.membershipId || !expected.companyMembershipId
    || !expected.companyId || !expected.tenantId || !expected.tenantMembershipId
    || expected.membershipId !== expected.companyMembershipId) {
    throw pricingAccessError("Active pricing context required");
  }
  const snapshot = await loadAccessSnapshot({ ...expected, requireFresh: true });
  if (!snapshot || !snapshot.permissionCodes.includes(permission)) {
    throw pricingAccessError("Forbidden");
  }
  const hasCompanyScope = snapshot.scopes.some((scope) =>
    scope.scopeType === "company" && scope.scopeRefId === snapshot.companyId);
  if (!hasCompanyScope) throw pricingAccessError("Company pricing scope required");
  return snapshot;
}

export function rejectPricingOwnershipInput(
  input: object,
  options: { allowCompanySelector?: boolean } = {},
) {
  for (const field of [
    "tenantId",
    "tenantMembershipId",
    "companyId",
    "companyMembershipId",
    "membershipId",
    "tenant",
    "company",
    "tenantCompany",
  ] as const) {
    if (field === "companyId" && options.allowCompanySelector) continue;
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      throw pricingAccessError(`${field} is server controlled`, 400);
    }
  }
}
