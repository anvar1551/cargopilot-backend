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

export async function requirePostingRuleMutation(actor: AppUser, intent: { companyId: string; actorUserId: string }): Promise<never> {
  const context = await requireLegalEntityContext(actor, "finance.postingRules.manage");
  if (!intent || intent.companyId !== context.companyId || intent.actorUserId !== context.userId)
    throw new FinanceError("Posting rule actor context mismatch", 403, "FINANCE_POSTING_RULE_CONTEXT_REJECTED");
  throw financeConflict("Posting rule configuration requires independent durable approval", "FINANCE_POSTING_RULE_APPROVAL_REQUIRED");
}

export async function requireBankAccountMutation(actor: AppUser, intent: { companyId: string; actorUserId: string }): Promise<void> {
  const context = await requireLegalEntityContext(actor, "finance.treasury.manage");
  if (!intent || intent.companyId !== context.companyId || intent.actorUserId !== context.userId)
    throw new FinanceError("Bank configuration actor context mismatch", 403, "FINANCE_BANK_CONTEXT_REJECTED");
  throw financeConflict("Bank configuration requires independent durable approval", "FINANCE_BANK_CONFIGURATION_APPROVAL_REQUIRED");
}

export async function requirePaymentRunMutation(actor: AppUser, intent: { companyId: string; actorUserId: string },
  operation: "create" | "submit" | "approve" | "reject" | "execute"): Promise<void> {
  const permission = operation === "execute" ? "finance.treasury.execute"
    : operation === "approve" || operation === "reject" ? "finance.treasury.approve" : "finance.treasury.manage";
  const context = await requireLegalEntityContext(actor, permission);
  if (!intent || intent.companyId !== context.companyId || intent.actorUserId !== context.userId)
    throw new FinanceError("Payment run actor context mismatch", 403, "FINANCE_PAYMENT_RUN_CONTEXT_REJECTED");
  throw financeConflict("Payment runs require authoritative financial basis and independent durable approval",
    "FINANCE_PAYMENT_RUN_ACCEPTANCE_REQUIRED");
}

export async function requireBankStatementMutation(actor: AppUser, intent: { companyId: string; actorUserId: string },
  operation: "create" | "reconcile" | "ignore" | "submit" | "approve" | "reject"): Promise<void> {
  const permission = operation === "approve" || operation === "reject" ? "finance.bankReconciliation.approve" : "finance.bankReconciliation.manage";
  const context = await requireLegalEntityContext(actor, permission);
  if (!intent || intent.companyId !== context.companyId || intent.actorUserId !== context.userId)
    throw new FinanceError("Bank statement actor context mismatch", 403, "FINANCE_BANK_STATEMENT_CONTEXT_REJECTED");
  throw financeConflict("Bank statements require authoritative source and independent durable reconciliation approval",
    "FINANCE_BANK_STATEMENT_ACCEPTANCE_REQUIRED");
}

export async function requireSettlementMutation(actor: AppUser, intent: {companyId:string;actorUserId:string}, operation:"create"|"reconcile"|"submit"|"approve"|"reject"): Promise<void> {
  const context=await requireLegalEntityContext(actor,operation==="approve"||operation==="reject"?"finance.settlements.approve":"finance.settlements.manage");
  if(!intent||intent.companyId!==context.companyId||intent.actorUserId!==context.userId)
    throw new FinanceError("Settlement actor context mismatch",403,"FINANCE_SETTLEMENT_CONTEXT_REJECTED");
  throw financeConflict("Settlement execution requires accepted provider source and independent durable approval","FINANCE_SETTLEMENT_ACCEPTANCE_REQUIRED");
}
