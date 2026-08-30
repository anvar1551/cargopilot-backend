import type { ReturnTypeOfPrepareBankStatement, ReturnTypeOfPreparePaymentRun } from "./finance-treasury.types";

export type TreasuryPage = { cursor?: string; limit: number; status?: string };

export interface FinanceTreasuryRepositoryPort {
  createBankAccount(command: {
    companyId: string;
    actorUserId: string;
    idempotencyKey: string;
    code: string;
    name: string;
    bankName: string;
    accountIdentifierHash: string;
    accountIdentifierMasked: string;
    currency: string;
    metadata?: Record<string, unknown>;
  }): Promise<any>;
  listBankAccounts(companyId: string, page: TreasuryPage): Promise<any>;
  changeBankAccountStatus(companyId: string, bankAccountId: string, actorUserId: string, isActive: boolean): Promise<any>;

  createPaymentRun(command: {
    companyId: string;
    actorUserId: string;
    bankAccountId: string;
    idempotencyKey: string;
    payloadHash: string;
    paymentRun: ReturnTypeOfPreparePaymentRun;
    metadata?: Record<string, unknown>;
  }): Promise<any>;
  listPaymentRuns(companyId: string, page: TreasuryPage): Promise<any>;
  getPaymentRun(companyId: string, paymentRunId: string): Promise<any>;
  submitPaymentRun(companyId: string, paymentRunId: string, actorUserId: string): Promise<any>;
  approvePaymentRun(companyId: string, paymentRunId: string, actorUserId: string): Promise<any>;
  rejectPaymentRun(companyId: string, paymentRunId: string, actorUserId: string, reason: string): Promise<any>;
  executePaymentRun(command: {
    companyId: string;
    paymentRunId: string;
    actorUserId: string;
    bankReference: string;
    executedAt: Date;
  }): Promise<any>;

  createBankStatement(command: {
    companyId: string;
    actorUserId: string;
    bankAccountId: string;
    statementNumber: string;
    idempotencyKey: string;
    payloadHash: string;
    statement: ReturnTypeOfPrepareBankStatement;
    metadata?: Record<string, unknown>;
  }): Promise<any>;
  listBankStatements(companyId: string, page: TreasuryPage): Promise<any>;
  getBankStatement(companyId: string, statementId: string): Promise<any>;
  reconcileBankStatementLine(command: {
    companyId: string;
    statementId: string;
    lineId: string;
    actorUserId: string;
    targetType: "payment_run" | "provider_settlement";
    targetId: string;
  }): Promise<any>;
  ignoreBankStatementLine(command: {
    companyId: string;
    statementId: string;
    lineId: string;
    actorUserId: string;
    reason: string;
  }): Promise<any>;
  submitBankStatement(companyId: string, statementId: string, actorUserId: string): Promise<any>;
  approveBankStatement(companyId: string, statementId: string, actorUserId: string): Promise<any>;
  rejectBankStatement(companyId: string, statementId: string, actorUserId: string, reason: string): Promise<any>;
}
