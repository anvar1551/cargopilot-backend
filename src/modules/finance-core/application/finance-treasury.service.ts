import type { AppUser } from "../../../types/app-user";
import { requirePaymentRunMutation, requireBankAccountMutation, requireLegalEntityContext } from "./legal-entity-access";
import { authoritativeDocumentHash } from "../domain/authoritative-documents";
import { financeConflict } from "../domain/finance.errors";
import {
  prepareBankStatement,
  preparePaymentRun,
  secureBankIdentifier,
  type BankStatementLineInput,
  type PaymentRunLineInput,
} from "../domain/treasury";
import type { FinanceTreasuryRepositoryPort, TreasuryPage } from "./finance-treasury.port";

export class FinanceTreasuryService {
  constructor(private readonly repository: FinanceTreasuryRepositoryPort) {}

  async createBankAccount(input: {
    companyId: string;
    actorUserId: string;
    idempotencyKey: string;
    code: string;
    name: string;
    bankName: string;
    accountIdentifier: string;
    currency: string;
    metadata?: Record<string, unknown>;
  }, actor: AppUser) {
    await requireBankAccountMutation(actor, input);
    const identifier = secureBankIdentifier(input.accountIdentifier);
    return this.repository.createBankAccount({
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      idempotencyKey: input.idempotencyKey,
      code: input.code.trim().toUpperCase(),
      name: input.name,
      bankName: input.bankName,
      currency: input.currency.trim().toUpperCase(),
      accountIdentifierHash: identifier.hash,
      accountIdentifierMasked: identifier.masked,
      metadata: input.metadata,
    }, actor);
  }

  async listBankAccounts(actor: AppUser, page: TreasuryPage) {
    await requireLegalEntityContext(actor, "finance.treasury.read");
    return this.repository.listBankAccounts(actor, page);
  }

  async changeBankAccountStatus(companyId: string, bankAccountId: string, actorUserId: string, isActive: boolean, actor: AppUser) {
    await requireBankAccountMutation(actor, {companyId, actorUserId});
    return this.repository.changeBankAccountStatus(companyId, bankAccountId, actorUserId, isActive, actor);
  }

  async createPaymentRun(input: {
    companyId: string;
    actorUserId: string;
    bankAccountId: string;
    idempotencyKey: string;
    paymentDate: Date;
    currency: string;
    fxRate: string;
    fxRateAsOf?: Date | null;
    lines: PaymentRunLineInput[];
    metadata?: Record<string, unknown>;
  }, actor: AppUser) {
    await requirePaymentRunMutation(actor, input, "create");
    const paymentRun = preparePaymentRun(input);
    return this.repository.createPaymentRun({
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      bankAccountId: input.bankAccountId,
      idempotencyKey: input.idempotencyKey,
      payloadHash: authoritativeDocumentHash({
        bankAccountId: input.bankAccountId,
        idempotencyKey: input.idempotencyKey,
        paymentRun,
        metadata: input.metadata,
      }),
      paymentRun,
      metadata: input.metadata,
    }, actor);
  }

  async listPaymentRuns(actor: AppUser, page: TreasuryPage) {
    await requireLegalEntityContext(actor, "finance.treasury.read");
    return this.repository.listPaymentRuns(actor, page);
  }

  async getPaymentRun(actor: AppUser, paymentRunId: string) {
    await requireLegalEntityContext(actor, "finance.treasury.read");
    return this.repository.getPaymentRun(actor, paymentRunId);
  }

  async submitPaymentRun(companyId: string, paymentRunId: string, actorUserId: string, actor: AppUser) {
    await requirePaymentRunMutation(actor, {companyId, actorUserId}, "submit");
    return this.repository.submitPaymentRun(companyId, paymentRunId, actorUserId, actor);
  }

  async approvePaymentRun(input: { companyId: string; paymentRunId: string; actorUserId: string }, actor: AppUser) {
    await requirePaymentRunMutation(actor, input, "approve");
    return this.repository.approvePaymentRun(input.companyId, input.paymentRunId, input.actorUserId, actor);
  }

  async rejectPaymentRun(companyId: string, paymentRunId: string, actorUserId: string, reason: string, actor: AppUser) {
    await requirePaymentRunMutation(actor, {companyId, actorUserId}, "reject");
    return this.repository.rejectPaymentRun(companyId, paymentRunId, actorUserId, reason, actor);
  }

  async executePaymentRun(input: Parameters<FinanceTreasuryRepositoryPort["executePaymentRun"]>[0], actor: AppUser) {
    await requirePaymentRunMutation(actor, input, "execute");
    return this.repository.executePaymentRun(input, actor);
  }

  createBankStatement(input: {
    companyId: string;
    actorUserId: string;
    bankAccountId: string;
    statementNumber: string;
    idempotencyKey: string;
    periodStart: Date;
    periodEnd: Date;
    currency: string;
    openingBalance: string;
    reportedClosingBalance: string;
    lines: BankStatementLineInput[];
    metadata?: Record<string, unknown>;
  }) {
    const statement = prepareBankStatement(input);
    return this.repository.createBankStatement({
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      bankAccountId: input.bankAccountId,
      statementNumber: input.statementNumber.trim(),
      idempotencyKey: input.idempotencyKey,
      payloadHash: authoritativeDocumentHash({
        bankAccountId: input.bankAccountId,
        statementNumber: input.statementNumber.trim(),
        statement,
        metadata: input.metadata,
      }),
      statement,
      metadata: input.metadata,
    });
  }

  listBankStatements(companyId: string, page: TreasuryPage) {
    return this.repository.listBankStatements(companyId, page);
  }

  getBankStatement(companyId: string, statementId: string) {
    return this.repository.getBankStatement(companyId, statementId);
  }

  reconcileBankStatementLine(input: Parameters<FinanceTreasuryRepositoryPort["reconcileBankStatementLine"]>[0]) {
    return this.repository.reconcileBankStatementLine(input);
  }

  ignoreBankStatementLine(input: Parameters<FinanceTreasuryRepositoryPort["ignoreBankStatementLine"]>[0]) {
    return this.repository.ignoreBankStatementLine(input);
  }

  submitBankStatement(companyId: string, statementId: string, actorUserId: string) {
    return this.repository.submitBankStatement(companyId, statementId, actorUserId);
  }

  async approveBankStatement(input: {
    companyId: string;
    statementId: string;
    actorUserId: string;
    allowSelfApproval: boolean;
  }) {
    const statement = await this.repository.getBankStatement(input.companyId, input.statementId);
    if (!input.allowSelfApproval && statement.createdByUserId === input.actorUserId) {
      throw financeConflict("Statement creator cannot approve it", "FINANCE_SELF_APPROVAL_FORBIDDEN");
    }
    return this.repository.approveBankStatement(input.companyId, input.statementId, input.actorUserId);
  }

  rejectBankStatement(companyId: string, statementId: string, actorUserId: string, reason: string) {
    return this.repository.rejectBankStatement(companyId, statementId, actorUserId, reason);
  }
}
