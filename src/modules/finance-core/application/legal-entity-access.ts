import type { AppUser } from "../../../types/app-user";
import prisma from "../../../config/prismaClient";
import { requireIdentityManagementContext } from "../../identity-access/application/managementAccess";
import { FinanceError, financeConflict } from "../domain/finance.errors";

/** Company-wide settings need explicit company scope, not warehouse/customer scope. */
export async function requireLegalEntityContext(actor: AppUser, permission: string) {
  const context = await requireIdentityManagementContext(actor, permission);
  // Access snapshots retain a legacy default company scope. Finance company-wide
  // reads/settings require an explicit stored grant rather than that fallback.
  const scope = await prisma.membershipScope.findFirst({ where: {
    membershipId: context.companyMembershipId, scopeType: "company", scopeRefId: context.companyId,
  }, select: { id: true } });
  if (!scope) throw new FinanceError("Explicit selected-company finance scope required", 403,
    "FINANCE_COMPANY_SCOPE_REQUIRED");
  return context;
}

export function rejectUnapprovedLegalEntityConfiguration(): never {
  throw financeConflict("Financial legal-entity configuration requires independent durable approval",
    "FINANCE_CONFIGURATION_APPROVAL_REQUIRED");
}

export function rejectUnapprovedPeriodConfiguration(): never {
  throw financeConflict("Fiscal period configuration and transitions require independent durable approval",
    "FINANCE_PERIOD_APPROVAL_REQUIRED");
}

export function rejectUnapprovedManualJournalExecution(): never {
  throw financeConflict("Manual journal posting and reversal require independent durable approval",
    "FINANCE_MANUAL_APPROVAL_REQUIRED");
}
