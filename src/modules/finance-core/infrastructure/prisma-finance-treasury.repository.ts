import {
  FinanceBankStatementStatus,
  FinancePaymentRunStatus,
  Prisma,
} from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type {
  FinanceTreasuryRepositoryPort,
  TreasuryPage,
} from "../application/finance-treasury.port";
import { financeConflict, financeNotFound } from "../domain/finance.errors";
import { createFinanceSourceEvent } from "./finance-source-event.store";

type Tx = Prisma.TransactionClient;

const bankAccountSelect = {
  id: true,
  legalEntityId: true,
  code: true,
  name: true,
  bankName: true,
  accountIdentifierMasked: true,
  currency: true,
  isActive: true,
  metadataJson: true,
  createdByUserId: true,
  updatedByUserId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.FinanceBankAccountSelect;

const paymentRunInclude = {
  bankAccount: { select: bankAccountSelect },
  lines: {
    orderBy: { sequence: "asc" as const },
    include: {
      payableItem: {
        select: {
          id: true,
          billNumber: true,
          supplierInvoiceNumber: true,
          dueDate: true,
          currency: true,
          originalAmount: true,
          outstandingAmount: true,
          status: true,
        },
      },
      allocation: true,
    },
  },
} satisfies Prisma.FinancePaymentRunInclude;

const paymentRunListInclude = {
  bankAccount: { select: bankAccountSelect },
  _count: { select: { lines: true } },
} satisfies Prisma.FinancePaymentRunInclude;

const bankStatementInclude = {
  bankAccount: { select: bankAccountSelect },
  lines: {
    orderBy: { sequence: "asc" as const },
    include: {
      paymentRun: { select: { id: true, runNumber: true, status: true, totalAmount: true } },
      providerSettlement: {
        select: { id: true, settlementNumber: true, status: true, netAmount: true },
      },
    },
  },
} satisfies Prisma.FinanceBankStatementInclude;

const bankStatementListInclude = {
  bankAccount: { select: bankAccountSelect },
  _count: { select: { lines: true } },
} satisfies Prisma.FinanceBankStatementInclude;

function json(value: Record<string, unknown> | undefined) {
  return value ? value as Prisma.InputJsonValue : undefined;
}

function pageResult<T extends { id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return {
    items,
    pageInfo: {
      hasMore,
      nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
    },
  };
}

async function requireEntity(tx: Tx, companyId: string) {
  const entity = await tx.financeLegalEntity.findUnique({ where: { companyId } });
  if (!entity || !entity.isActive) {
    throw financeNotFound("Finance legal entity is not configured", "FINANCE_ENTITY_NOT_CONFIGURED");
  }
  return entity;
}

async function lock(tx: Tx, key: string) {
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

async function allocateNumber(tx: Tx, legalEntityId: string, key: string, prefix: string) {
  const sequence = await tx.financeNumberSequence.upsert({
    where: { legalEntityId_key: { legalEntityId, key } },
    create: { legalEntityId, key, prefix, nextValue: 2n, padding: 8 },
    update: { nextValue: { increment: 1 } },
  });
  return `${sequence.prefix}${(sequence.nextValue - 1n).toString().padStart(sequence.padding, "0")}`;
}

function assertFxSnapshot(entity: { baseCurrency: string }, input: { currency: string; fxRateAsOf: Date | null }) {
  if (input.currency !== entity.baseCurrency && !input.fxRateAsOf) {
    throw financeConflict("Foreign-currency treasury documents require fxRateAsOf", "FINANCE_FX_SNAPSHOT_REQUIRED");
  }
}

function paymentRunStatus(value?: string) {
  return value && Object.values(FinancePaymentRunStatus).includes(value as FinancePaymentRunStatus)
    ? value as FinancePaymentRunStatus
    : undefined;
}

function statementStatus(value?: string) {
  return value && Object.values(FinanceBankStatementStatus).includes(value as FinanceBankStatementStatus)
    ? value as FinanceBankStatementStatus
    : undefined;
}

export class PrismaFinanceTreasuryRepository implements FinanceTreasuryRepositoryPort {
  async createBankAccount(command: Parameters<FinanceTreasuryRepositoryPort["createBankAccount"]>[0]) {
    return prisma.$transaction(async (tx) => {
      const entity = await requireEntity(tx, command.companyId);
      await lock(tx, `${entity.id}:bank-account:${command.idempotencyKey}`);
      const existing = await tx.financeBankAccount.findUnique({
        where: { legalEntityId_idempotencyKey: { legalEntityId: entity.id, idempotencyKey: command.idempotencyKey } },
      });
      if (existing) {
        if (existing.accountIdentifierHash !== command.accountIdentifierHash ||
          existing.code !== command.code || existing.currency !== command.currency) {
          throw financeConflict("Bank-account idempotency key was reused with different contents", "FINANCE_IDEMPOTENCY_CONFLICT");
        }
        return tx.financeBankAccount.findUniqueOrThrow({ where: { id: existing.id }, select: bankAccountSelect });
      }
      const account = await tx.financeBankAccount.create({
        data: {
          legalEntityId: entity.id,
          code: command.code,
          name: command.name,
          bankName: command.bankName,
          accountIdentifierHash: command.accountIdentifierHash,
          accountIdentifierMasked: command.accountIdentifierMasked,
          currency: command.currency,
          idempotencyKey: command.idempotencyKey,
          metadataJson: json(command.metadata),
          createdByUserId: command.actorUserId,
          updatedByUserId: command.actorUserId,
        },
        select: bankAccountSelect,
      });
      await tx.financeAuditEvent.create({
        data: {
          legalEntityId: entity.id,
          action: "finance.bank_account.created",
          actorUserId: command.actorUserId,
          detailsJson: { bankAccountId: account.id, code: account.code, currency: account.currency },
        },
      });
      return account;
    });
  }

  async listBankAccounts(companyId: string, page: TreasuryPage) {
    const rows = await prisma.financeBankAccount.findMany({
      where: {
        legalEntity: { companyId },
        ...(page.status === "active" ? { isActive: true } : {}),
        ...(page.status === "inactive" ? { isActive: false } : {}),
      },
      orderBy: [{ code: "asc" }, { id: "asc" }],
      take: page.limit + 1,
      ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
      select: bankAccountSelect,
    });
    return pageResult(rows, page.limit);
  }

  async changeBankAccountStatus(companyId: string, bankAccountId: string, actorUserId: string, isActive: boolean) {
    return prisma.$transaction(async (tx) => {
      const account = await tx.financeBankAccount.findFirst({
        where: { id: bankAccountId, legalEntity: { companyId } },
      });
      if (!account) throw financeNotFound("Bank account not found", "FINANCE_BANK_ACCOUNT_NOT_FOUND");
      const updated = await tx.financeBankAccount.update({
        where: { id: account.id },
        data: { isActive, updatedByUserId: actorUserId },
        select: bankAccountSelect,
      });
      await tx.financeAuditEvent.create({
        data: {
          legalEntityId: account.legalEntityId,
          action: "finance.bank_account.status_changed",
          actorUserId,
          detailsJson: { bankAccountId: account.id, isActive },
        },
      });
      return updated;
    });
  }

  async createPaymentRun(command: Parameters<FinanceTreasuryRepositoryPort["createPaymentRun"]>[0]) {
    return prisma.$transaction(async (tx) => {
      const entity = await requireEntity(tx, command.companyId);
      assertFxSnapshot(entity, command.paymentRun);
      await lock(tx, `${entity.id}:payment-run:${command.idempotencyKey}`);
      const existing = await tx.financePaymentRun.findUnique({
        where: { legalEntityId_idempotencyKey: { legalEntityId: entity.id, idempotencyKey: command.idempotencyKey } },
        include: paymentRunInclude,
      });
      if (existing) {
        if (existing.payloadHash !== command.payloadHash) {
          throw financeConflict("Payment-run idempotency key was reused with different contents", "FINANCE_IDEMPOTENCY_CONFLICT");
        }
        return existing;
      }
      const bank = await tx.financeBankAccount.findFirst({
        where: { id: command.bankAccountId, legalEntityId: entity.id, isActive: true },
      });
      if (!bank) throw financeNotFound("Active bank account not found", "FINANCE_BANK_ACCOUNT_NOT_FOUND");
      if (bank.currency !== command.paymentRun.currency) {
        throw financeConflict("Payment-run currency must match bank-account currency", "FINANCE_PAYMENT_RUN_CURRENCY_MISMATCH");
      }
      const payableIds = command.paymentRun.lines.map((line) => line.payableItemId);
      for (const payableId of [...payableIds].sort()) {
        await lock(tx, `${entity.id}:payable-reservation:${payableId}`);
      }
      const payables = await tx.financePayableItem.findMany({
        where: { id: { in: payableIds }, legalEntityId: entity.id },
      });
      if (payables.length !== payableIds.length) {
        throw financeNotFound("One or more payable items were not found", "FINANCE_PAYABLE_NOT_FOUND");
      }
      const reserved = await tx.financePaymentRunLine.groupBy({
        by: ["payableItemId"],
        where: {
          payableItemId: { in: payableIds },
          status: { in: ["pending", "executed"] },
          paymentRun: { status: { in: ["draft", "submitted", "approved", "executed"] } },
        },
        _sum: { amount: true },
      });
      const reservedByPayable = new Map(reserved.map((row) => [row.payableItemId, row._sum.amount ?? new Prisma.Decimal(0)]));
      const payableById = new Map(payables.map((payable) => [payable.id, payable]));
      for (const line of command.paymentRun.lines) {
        const payable = payableById.get(line.payableItemId)!;
        if (payable.currency !== command.paymentRun.currency) {
          throw financeConflict("Every payable must match the payment-run currency", "FINANCE_PAYMENT_RUN_CURRENCY_MISMATCH");
        }
        const available = payable.outstandingAmount.minus(reservedByPayable.get(payable.id) ?? 0);
        if (new Prisma.Decimal(line.amount).gt(available)) {
          throw financeConflict(
            `Payment amount exceeds available payable balance for ${payable.billNumber}`,
            "FINANCE_PAYMENT_RUN_OVER_ALLOCATION",
          );
        }
      }
      const runNumber = await allocateNumber(tx, entity.id, "payment_run", "PAYRUN-");
      const paymentRun = await tx.financePaymentRun.create({
        data: {
          legalEntityId: entity.id,
          bankAccountId: bank.id,
          runNumber,
          paymentDate: command.paymentRun.paymentDate,
          currency: command.paymentRun.currency,
          totalAmount: command.paymentRun.totalAmount,
          fxRate: command.paymentRun.fxRate,
          fxRateAsOf: command.paymentRun.fxRateAsOf,
          idempotencyKey: command.idempotencyKey,
          payloadHash: command.payloadHash,
          metadataJson: json(command.metadata),
          createdByUserId: command.actorUserId,
          lines: {
            create: command.paymentRun.lines.map((line) => {
              const payable = payableById.get(line.payableItemId)!;
              return {
                sequence: line.sequence,
                payableItemId: payable.id,
                carrierProviderId: payable.carrierProviderId,
                carrierCode: payable.carrierCode,
                amount: line.amount,
              };
            }),
          },
        },
        include: paymentRunInclude,
      });
      await tx.financeAuditEvent.create({
        data: {
          legalEntityId: entity.id,
          action: "finance.payment_run.created",
          actorUserId: command.actorUserId,
          detailsJson: {
            paymentRunId: paymentRun.id,
            runNumber: paymentRun.runNumber,
            currency: paymentRun.currency,
            totalAmount: paymentRun.totalAmount.toFixed(4),
          },
        },
      });
      return paymentRun;
    });
  }

  async listPaymentRuns(companyId: string, page: TreasuryPage) {
    const rows = await prisma.financePaymentRun.findMany({
      where: { legalEntity: { companyId }, ...(paymentRunStatus(page.status) ? { status: paymentRunStatus(page.status) } : {}) },
      orderBy: [{ paymentDate: "desc" }, { id: "desc" }],
      take: page.limit + 1,
      ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
      include: paymentRunListInclude,
    });
    return pageResult(rows, page.limit);
  }

  async getPaymentRun(companyId: string, paymentRunId: string) {
    const row = await prisma.financePaymentRun.findFirst({
      where: { id: paymentRunId, legalEntity: { companyId } },
      include: paymentRunInclude,
    });
    if (!row) throw financeNotFound("Payment run not found", "FINANCE_PAYMENT_RUN_NOT_FOUND");
    return row;
  }

  async submitPaymentRun(companyId: string, paymentRunId: string, actorUserId: string) {
    return prisma.$transaction(async (tx) => {
      const row = await tx.financePaymentRun.findFirst({ where: { id: paymentRunId, legalEntity: { companyId } } });
      if (!row) throw financeNotFound("Payment run not found", "FINANCE_PAYMENT_RUN_NOT_FOUND");
      if (row.status !== "draft") throw financeConflict("Only draft payment runs can be submitted", "FINANCE_WORKFLOW_STATE_INVALID");
      await tx.financePaymentRun.update({ where: { id: row.id }, data: { status: "submitted", submittedByUserId: actorUserId, submittedAt: new Date() } });
      await tx.financeAuditEvent.create({ data: { legalEntityId: row.legalEntityId, action: "finance.payment_run.submitted", actorUserId, detailsJson: { paymentRunId: row.id } } });
      return tx.financePaymentRun.findUniqueOrThrow({ where: { id: row.id }, include: paymentRunInclude });
    });
  }

  async approvePaymentRun(companyId: string, paymentRunId: string, actorUserId: string) {
    return prisma.$transaction(async (tx) => {
      await lock(tx, `payment-run-approval:${paymentRunId}`);
      const row = await tx.financePaymentRun.findFirst({ where: { id: paymentRunId, legalEntity: { companyId } } });
      if (!row) throw financeNotFound("Payment run not found", "FINANCE_PAYMENT_RUN_NOT_FOUND");
      if (row.status === "approved") return tx.financePaymentRun.findUniqueOrThrow({ where: { id: row.id }, include: paymentRunInclude });
      if (row.status !== "submitted") throw financeConflict("Only submitted payment runs can be approved", "FINANCE_WORKFLOW_STATE_INVALID");
      await tx.financePaymentRun.update({ where: { id: row.id }, data: { status: "approved", approvedByUserId: actorUserId, approvedAt: new Date() } });
      await tx.financeAuditEvent.create({ data: { legalEntityId: row.legalEntityId, action: "finance.payment_run.approved", actorUserId, detailsJson: { paymentRunId: row.id } } });
      return tx.financePaymentRun.findUniqueOrThrow({ where: { id: row.id }, include: paymentRunInclude });
    });
  }

  async rejectPaymentRun(companyId: string, paymentRunId: string, actorUserId: string, reason: string) {
    return prisma.$transaction(async (tx) => {
      const row = await tx.financePaymentRun.findFirst({ where: { id: paymentRunId, legalEntity: { companyId } } });
      if (!row) throw financeNotFound("Payment run not found", "FINANCE_PAYMENT_RUN_NOT_FOUND");
      if (row.status !== "submitted") throw financeConflict("Only submitted payment runs can be rejected", "FINANCE_WORKFLOW_STATE_INVALID");
      await tx.financePaymentRun.update({ where: { id: row.id }, data: { status: "rejected", rejectedByUserId: actorUserId, rejectedAt: new Date(), rejectionReason: reason, lines: { updateMany: { where: { status: "pending" }, data: { status: "cancelled" } } } } });
      await tx.financeAuditEvent.create({ data: { legalEntityId: row.legalEntityId, action: "finance.payment_run.rejected", actorUserId, detailsJson: { paymentRunId: row.id, reason } } });
      return tx.financePaymentRun.findUniqueOrThrow({ where: { id: row.id }, include: paymentRunInclude });
    });
  }

  async executePaymentRun(command: Parameters<FinanceTreasuryRepositoryPort["executePaymentRun"]>[0]) {
    return prisma.$transaction(async (tx) => {
      await lock(tx, `payment-run-execution:${command.paymentRunId}`);
      const row = await tx.financePaymentRun.findFirst({
        where: { id: command.paymentRunId, legalEntity: { companyId: command.companyId } },
        include: { ...paymentRunInclude, legalEntity: true },
      });
      if (!row) throw financeNotFound("Payment run not found", "FINANCE_PAYMENT_RUN_NOT_FOUND");
      if (row.status === "executed") return row;
      if (row.status !== "approved") throw financeConflict("Only approved payment runs can be executed", "FINANCE_WORKFLOW_STATE_INVALID");
      if (command.executedAt < row.paymentDate) {
        throw financeConflict("Execution time cannot precede payment date", "FINANCE_PAYMENT_EXECUTION_DATE_INVALID");
      }
      for (const payableId of row.lines.map((line) => line.payableItemId).sort()) {
        await lock(tx, `${row.legalEntityId}:payable-reservation:${payableId}`);
      }
      for (const line of row.lines) {
        if (line.status !== "pending" || new Prisma.Decimal(line.amount).gt(line.payableItem.outstandingAmount)) {
          throw financeConflict(
            `Payable balance changed after approval for ${line.payableItem.billNumber}`,
            "FINANCE_PAYMENT_RUN_BALANCE_CHANGED",
          );
        }
        const sourceEventId = `payable_payment:${line.id}:executed`;
        await createFinanceSourceEvent(tx, row.legalEntityId, {
          sourceEventId,
          companyId: command.companyId,
          sourceType: "payable",
          eventType: "payable.payment_executed",
          sourceId: line.id,
          actorUserId: command.actorUserId,
          occurredAt: command.executedAt,
          documentDate: command.executedAt,
          postingDate: command.executedAt,
          currency: row.currency,
          fxRate: row.fxRate.toFixed(10),
          fxRateAsOf: row.fxRateAsOf,
          amounts: { payable_amount: line.amount.toFixed(4) },
          dimensions: { carrierProviderId: line.carrierProviderId },
          attributes: {
            carrierCode: line.carrierCode,
            paymentRunNumber: row.runNumber,
            bankAccountCode: row.bankAccount.code,
          },
          description: `Supplier payment ${row.runNumber} for ${line.payableItem.billNumber}`,
          metadata: {
            paymentRunId: row.id,
            paymentRunLineId: line.id,
            payableItemId: line.payableItemId,
            bankAccountId: row.bankAccountId,
            bankReference: command.bankReference,
          },
        });
        await tx.financePaymentRunLine.update({ where: { id: line.id }, data: { status: "executed", accountingSourceEventId: sourceEventId } });
      }
      await tx.financePaymentRun.update({ where: { id: row.id }, data: { status: "executed", bankReference: command.bankReference, executedByUserId: command.actorUserId, executedAt: command.executedAt } });
      await tx.financeAuditEvent.create({ data: { legalEntityId: row.legalEntityId, action: "finance.payment_run.executed", actorUserId: command.actorUserId, detailsJson: { paymentRunId: row.id, bankReference: command.bankReference } } });
      return tx.financePaymentRun.findUniqueOrThrow({ where: { id: row.id }, include: paymentRunInclude });
    });
  }

  async createBankStatement(command: Parameters<FinanceTreasuryRepositoryPort["createBankStatement"]>[0]) {
    return prisma.$transaction(async (tx) => {
      const entity = await requireEntity(tx, command.companyId);
      await lock(tx, `${entity.id}:bank-statement:${command.idempotencyKey}`);
      const existing = await tx.financeBankStatement.findUnique({
        where: { legalEntityId_idempotencyKey: { legalEntityId: entity.id, idempotencyKey: command.idempotencyKey } },
        include: bankStatementInclude,
      });
      if (existing) {
        if (existing.payloadHash !== command.payloadHash) throw financeConflict("Statement idempotency key was reused with different contents", "FINANCE_IDEMPOTENCY_CONFLICT");
        return existing;
      }
      const bank = await tx.financeBankAccount.findFirst({ where: { id: command.bankAccountId, legalEntityId: entity.id } });
      if (!bank) throw financeNotFound("Bank account not found", "FINANCE_BANK_ACCOUNT_NOT_FOUND");
      if (bank.currency !== command.statement.currency) throw financeConflict("Statement currency must match bank-account currency", "FINANCE_BANK_CURRENCY_MISMATCH");
      const externalTransactionIds = command.statement.lines
        .map((line) => line.externalTransactionId)
        .filter((value): value is string => Boolean(value));
      for (const externalTransactionId of [...externalTransactionIds].sort()) {
        await lock(tx, `${bank.id}:bank-transaction:${externalTransactionId}`);
      }
      if (externalTransactionIds.length > 0) {
        const duplicate = await tx.financeBankStatementLine.findFirst({
          where: {
            bankAccountId: bank.id,
            externalTransactionId: { in: externalTransactionIds },
          },
          select: { externalTransactionId: true },
        });
        if (duplicate) {
          throw financeConflict(
            `Bank transaction ${duplicate.externalTransactionId} was already imported`,
            "FINANCE_BANK_TRANSACTION_DUPLICATE",
          );
        }
      }
      const statement = await tx.financeBankStatement.create({
        data: {
          legalEntityId: entity.id,
          bankAccountId: bank.id,
          statementNumber: command.statementNumber,
          periodStart: command.statement.periodStart,
          periodEnd: command.statement.periodEnd,
          currency: command.statement.currency,
          openingBalance: command.statement.openingBalance,
          totalDebits: command.statement.totalDebits,
          totalCredits: command.statement.totalCredits,
          closingBalance: command.statement.closingBalance,
          idempotencyKey: command.idempotencyKey,
          payloadHash: command.payloadHash,
          metadataJson: json(command.metadata),
          createdByUserId: command.actorUserId,
          lines: { create: command.statement.lines.map((line) => ({
            bankAccountId: bank.id,
            sequence: line.sequence,
            bookingDate: line.bookingDate,
            valueDate: line.valueDate,
            direction: line.direction,
            amount: line.amount,
            currency: command.statement.currency,
            externalTransactionId: line.externalTransactionId,
            description: line.description,
            metadataJson: json(line.metadata),
          })) },
        },
        include: bankStatementInclude,
      });
      await tx.financeAuditEvent.create({
        data: {
          legalEntityId: entity.id,
          action: "finance.bank_statement.created",
          actorUserId: command.actorUserId,
          detailsJson: {
            statementId: statement.id,
            statementNumber: statement.statementNumber,
            bankAccountId: statement.bankAccountId,
            currency: statement.currency,
          },
        },
      });
      return statement;
    });
  }

  async listBankStatements(companyId: string, page: TreasuryPage) {
    const status = statementStatus(page.status);
    const rows = await prisma.financeBankStatement.findMany({
      where: { legalEntity: { companyId }, ...(status ? { status } : {}) },
      orderBy: [{ periodEnd: "desc" }, { id: "desc" }],
      take: page.limit + 1,
      ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
      include: bankStatementListInclude,
    });
    return pageResult(rows, page.limit);
  }

  async getBankStatement(companyId: string, statementId: string) {
    const row = await prisma.financeBankStatement.findFirst({ where: { id: statementId, legalEntity: { companyId } }, include: bankStatementInclude });
    if (!row) throw financeNotFound("Bank statement not found", "FINANCE_BANK_STATEMENT_NOT_FOUND");
    return row;
  }

  async reconcileBankStatementLine(command: Parameters<FinanceTreasuryRepositoryPort["reconcileBankStatementLine"]>[0]) {
    return prisma.$transaction(async (tx) => {
      await lock(tx, `bank-line-reconcile:${command.lineId}`);
      const line = await tx.financeBankStatementLine.findFirst({
        where: { id: command.lineId, bankStatementId: command.statementId, bankStatement: { legalEntity: { companyId: command.companyId } } },
        include: { bankStatement: true },
      });
      if (!line) throw financeNotFound("Bank statement line not found", "FINANCE_BANK_LINE_NOT_FOUND");
      if (line.bankStatement.status !== "draft") throw financeConflict("Only draft statements can be reconciled", "FINANCE_WORKFLOW_STATE_INVALID");
      const now = new Date();
      if (command.targetType === "payment_run") {
        const run = await tx.financePaymentRun.findFirst({ where: { id: command.targetId, legalEntityId: line.bankStatement.legalEntityId } });
        if (!run || run.status !== "executed") throw financeNotFound("Executed payment run not found", "FINANCE_RECONCILIATION_TARGET_NOT_FOUND");
        if (line.direction !== "debit" || line.currency !== run.currency || !line.amount.equals(run.totalAmount) || line.bankStatement.bankAccountId !== run.bankAccountId) {
          throw financeConflict("Bank debit does not match payment run", "FINANCE_BANK_RECONCILIATION_MISMATCH");
        }
        await tx.financeBankStatementLine.update({ where: { id: line.id }, data: { reconciliationStatus: "matched", reconciliationTarget: "payment_run", paymentRunId: run.id, providerSettlementId: null, reconciliationMessage: null, reconciledByUserId: command.actorUserId, reconciledAt: now } });
      } else {
        const settlement = await tx.financeProviderSettlement.findFirst({ where: { id: command.targetId, legalEntityId: line.bankStatement.legalEntityId } });
        if (!settlement || settlement.status !== "approved") throw financeNotFound("Approved provider settlement not found", "FINANCE_RECONCILIATION_TARGET_NOT_FOUND");
        if (line.direction !== "credit" || line.currency !== settlement.currency || !line.amount.equals(settlement.netAmount)) {
          throw financeConflict("Bank credit does not match provider settlement", "FINANCE_BANK_RECONCILIATION_MISMATCH");
        }
        await tx.financeBankStatementLine.update({ where: { id: line.id }, data: { reconciliationStatus: "matched", reconciliationTarget: "provider_settlement", providerSettlementId: settlement.id, paymentRunId: null, reconciliationMessage: null, reconciledByUserId: command.actorUserId, reconciledAt: now } });
      }
      await tx.financeAuditEvent.create({ data: { legalEntityId: line.bankStatement.legalEntityId, action: "finance.bank_statement_line.reconciled", actorUserId: command.actorUserId, detailsJson: { statementId: command.statementId, lineId: line.id, targetType: command.targetType, targetId: command.targetId } } });
      return tx.financeBankStatement.findUniqueOrThrow({ where: { id: command.statementId }, include: bankStatementInclude });
    });
  }

  async ignoreBankStatementLine(command: Parameters<FinanceTreasuryRepositoryPort["ignoreBankStatementLine"]>[0]) {
    return prisma.$transaction(async (tx) => {
      const line = await tx.financeBankStatementLine.findFirst({ where: { id: command.lineId, bankStatementId: command.statementId, bankStatement: { legalEntity: { companyId: command.companyId } } }, include: { bankStatement: true } });
      if (!line) throw financeNotFound("Bank statement line not found", "FINANCE_BANK_LINE_NOT_FOUND");
      if (line.bankStatement.status !== "draft") throw financeConflict("Only draft statements can be changed", "FINANCE_WORKFLOW_STATE_INVALID");
      await tx.financeBankStatementLine.update({ where: { id: line.id }, data: { reconciliationStatus: "ignored", reconciliationTarget: null, paymentRunId: null, providerSettlementId: null, reconciliationMessage: command.reason, reconciledByUserId: command.actorUserId, reconciledAt: new Date() } });
      await tx.financeAuditEvent.create({ data: { legalEntityId: line.bankStatement.legalEntityId, action: "finance.bank_statement_line.ignored", actorUserId: command.actorUserId, detailsJson: { statementId: command.statementId, lineId: line.id, reason: command.reason } } });
      return tx.financeBankStatement.findUniqueOrThrow({ where: { id: command.statementId }, include: bankStatementInclude });
    });
  }

  async submitBankStatement(companyId: string, statementId: string, actorUserId: string) {
    return prisma.$transaction(async (tx) => {
      const row = await tx.financeBankStatement.findFirst({ where: { id: statementId, legalEntity: { companyId } }, include: { lines: true } });
      if (!row) throw financeNotFound("Bank statement not found", "FINANCE_BANK_STATEMENT_NOT_FOUND");
      if (row.status !== "draft") throw financeConflict("Only draft statements can be submitted", "FINANCE_WORKFLOW_STATE_INVALID");
      if (row.lines.some((line) => !["matched", "ignored"].includes(line.reconciliationStatus))) {
        throw financeConflict("All statement lines must be matched or explicitly ignored", "FINANCE_BANK_RECONCILIATION_INCOMPLETE");
      }
      await tx.financeBankStatement.update({ where: { id: row.id }, data: { status: "submitted", submittedByUserId: actorUserId, submittedAt: new Date() } });
      await tx.financeAuditEvent.create({ data: { legalEntityId: row.legalEntityId, action: "finance.bank_statement.submitted", actorUserId, detailsJson: { statementId: row.id } } });
      return tx.financeBankStatement.findUniqueOrThrow({ where: { id: row.id }, include: bankStatementInclude });
    });
  }

  async approveBankStatement(companyId: string, statementId: string, actorUserId: string) {
    return prisma.$transaction(async (tx) => {
      await lock(tx, `bank-statement-approval:${statementId}`);
      const row = await tx.financeBankStatement.findFirst({ where: { id: statementId, legalEntity: { companyId } } });
      if (!row) throw financeNotFound("Bank statement not found", "FINANCE_BANK_STATEMENT_NOT_FOUND");
      if (row.status === "approved") return tx.financeBankStatement.findUniqueOrThrow({ where: { id: row.id }, include: bankStatementInclude });
      if (row.status !== "submitted") throw financeConflict("Only submitted statements can be approved", "FINANCE_WORKFLOW_STATE_INVALID");
      await tx.financeBankStatement.update({ where: { id: row.id }, data: { status: "approved", approvedByUserId: actorUserId, approvedAt: new Date() } });
      await tx.financeAuditEvent.create({ data: { legalEntityId: row.legalEntityId, action: "finance.bank_statement.approved", actorUserId, detailsJson: { statementId: row.id } } });
      return tx.financeBankStatement.findUniqueOrThrow({ where: { id: row.id }, include: bankStatementInclude });
    });
  }

  async rejectBankStatement(companyId: string, statementId: string, actorUserId: string, reason: string) {
    return prisma.$transaction(async (tx) => {
      const row = await tx.financeBankStatement.findFirst({ where: { id: statementId, legalEntity: { companyId } } });
      if (!row) throw financeNotFound("Bank statement not found", "FINANCE_BANK_STATEMENT_NOT_FOUND");
      if (row.status !== "submitted") throw financeConflict("Only submitted statements can be rejected", "FINANCE_WORKFLOW_STATE_INVALID");
      await tx.financeBankStatement.update({ where: { id: row.id }, data: { status: "rejected", rejectedByUserId: actorUserId, rejectedAt: new Date(), rejectionReason: reason } });
      await tx.financeAuditEvent.create({ data: { legalEntityId: row.legalEntityId, action: "finance.bank_statement.rejected", actorUserId, detailsJson: { statementId: row.id, reason } } });
      return tx.financeBankStatement.findUniqueOrThrow({ where: { id: row.id }, include: bankStatementInclude });
    });
  }
}

export const prismaFinanceTreasuryRepository = new PrismaFinanceTreasuryRepository();
