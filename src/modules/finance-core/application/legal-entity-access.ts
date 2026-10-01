import type { AppUser } from "../../../types/app-user";
import { requireIdentityManagementContext } from "../../identity-access/application/managementAccess";
import { financeConflict } from "../domain/finance.errors";

/** Company-wide settings need explicit company scope, not warehouse/customer scope. */
export function requireLegalEntityContext(actor: AppUser, permission: string) {
  return requireIdentityManagementContext(actor, permission);
}

export function rejectUnapprovedLegalEntityConfiguration(): never {
  throw financeConflict("Financial legal-entity configuration requires independent durable approval",
    "FINANCE_CONFIGURATION_APPROVAL_REQUIRED");
}
