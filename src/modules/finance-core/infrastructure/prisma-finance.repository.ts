import { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type {
  ChangePeriodStatusCommand,
  BootstrapChartCommand,
  ConfigureLegalEntityCommand,
  CreateAccountCommand,
  CreateJournalCommand,
  CreatePeriodCommand,
  CreatePostingRuleCommand,
  CreatePostingRuleVersionCommand,
  CursorPage,
  FinanceRepositoryPort,
  ReverseJournalCommand,
  IngestFinanceSourceEventCommand,
} from "../application/finance.port";
import {
  FinanceError,
  financeConflict,
  financeNotFound,
} from "../domain/finance.errors";
import { formatSequence, prepareJournal } from "../domain/ledger";
import {
  documentTypeForSource,
  financeSourceEventHash,
  normalizeFinanceSourceEvent,
  postingRuleMatches,
} from "../domain/source-event";
import { projectFinanceSubledgerEvent } from "./finance-subledger.projector";

type Tx = Prisma.TransactionClient;

const journalInclude = {
  document: true,
  lines: {
    orderBy: { lineNumber: "asc" as const },
    include: { account: true },
  },
} satisfies Prisma.FinanceJournalEntryInclude;

const postingRuleInclude = {
  lines: {
    orderBy: { lineNumber: "asc" as const },
    include: { account: { select: { id: true, code: true, name: true, type: true } } },
  },
} satisfies Prisma.FinancePostingRuleInclude;

function json(value: Record<string, unknown> | undefined) {
  return value ? (value as Prisma.InputJsonValue) : undefined;
}

async function requireLegalEntity(tx: Tx, companyId: string) {
  const entity = await tx.financeLegalEntity.findUnique({ where: { companyId } });
  if (!entity || !entity.isActive) {
    throw financeNotFound(
      "Finance legal entity is not configured for this company",
      "FINANCE_ENTITY_NOT_CONFIGURED",
    );
  }
  return entity;
}

async function requireOpenPeriod(tx: Tx, legalEntityId: string, postingDate: Date) {
  const period = await tx.financeFiscalPeriod.findFirst({
    where: {
      legalEntityId,
      startDate: { lte: postingDate },
      endDate: { gte: postingDate },
    },
  });
  if (!period) {
    throw financeConflict(
      "No fiscal period covers the requested posting date",
      "FINANCE_PERIOD_MISSING",
    );
  }
  if (period.status !== "open") {
    throw financeConflict(
      `Fiscal period ${period.name} is ${period.status}`,
      "FINANCE_PERIOD_NOT_OPEN",
    );
  }
  return period;
}

async function allocateNumber(
  tx: Tx,
  legalEntityId: string,
  key: string,
  prefix: string,
) {
  const sequence = await tx.financeNumberSequence.upsert({
    where: { legalEntityId_key: { legalEntityId, key } },
    create: { legalEntityId, key, prefix, nextValue: 2n, padding: 8 },
    update: { nextValue: { increment: 1 } },
  });
  return formatSequence(sequence.prefix, sequence.nextValue - 1n, sequence.padding);
}

async function enqueueEvent(
  tx: Tx,
  input: {
    legalEntityId: string;
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: Record<string, unknown>;
  },
) {
  return tx.financeDomainEventOutbox.create({
    data: {
      legalEntityId: input.legalEntityId,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      eventType: input.eventType,
      occurredAt: new Date(),
      payloadJson: input.payload as Prisma.InputJsonValue,
    },
  });
}

async function findJournal(tx: Tx, companyId: string, journalId: string) {
  const journal = await tx.financeJournalEntry.findFirst({
    where: { id: journalId, legalEntity: { companyId } },
    include: {
      ...journalInclude,
      legalEntity: true,
    },
  });
  if (!journal) {
    throw financeNotFound("Finance journal not found", "FINANCE_JOURNAL_NOT_FOUND");
  }
  return journal;
}

async function validatePostingRuleAccounts(
  tx: Tx,
  legalEntityId: string,
  accountIds: string[],
) {
  const uniqueIds = [...new Set(accountIds)];
  const accounts = await tx.financeAccount.findMany({
    where: { id: { in: uniqueIds }, legalEntityId },
  });
  if (accounts.length !== uniqueIds.length) {
    throw financeNotFound(
      "One or more posting-rule accounts do not belong to this finance entity",
      "FINANCE_ACCOUNT_SCOPE_MISMATCH",
    );
  }
  const invalid = accounts.find(
    (account) => account.status !== "active" || !account.allowPosting,
  );
  if (invalid) {
    throw financeConflict(
      `Account ${invalid.code} is not available for automatic posting`,
      "FINANCE_ACCOUNT_NOT_POSTABLE",
    );
  }
}

async function createPostingRuleTx(
  tx: Tx,
  legalEntityId: string,
  command: CreatePostingRuleCommand,
  version: number,
) {
  await validatePostingRuleAccounts(
    tx,
    legalEntityId,
    command.lines.map((line) => line.accountId),
  );
  return tx.financePostingRule.create({
    data: {
      legalEntityId,
      code: command.code,
      name: command.name,
      sourceType: command.sourceType,
      eventType: command.eventType,
      version,
      priority: command.priority,
      conditionsJson: json(command.conditions),
      validFrom: command.validFrom,
      validTo: command.validTo,
      lines: {
        create: command.lines.map((line, index) => ({
          lineNumber: index + 1,
          side: line.side,
          accountId: line.accountId,
          amountExpression: line.amountKey,
          descriptionTemplate: line.descriptionTemplate,
          dimensionsJson: json(line.dimensions),
        })),
      },
    },
    include: postingRuleInclude,
  });
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

function sourceEventJson(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function renderPostingDescription(
  template: string | null,
  context: Record<string, unknown>,
) {
  if (!template) return null;
  return template.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (_match, key: string) => {
    const value = context[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

export class PrismaFinanceRepository implements FinanceRepositoryPort {
  async getLegalEntity(companyId: string) {
    return prisma.financeLegalEntity.findUnique({ where: { companyId } });
  }

  async configureLegalEntity(command: ConfigureLegalEntityCommand) {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.financeLegalEntity.findUnique({
        where: { companyId: command.companyId },
      });
      if (existing && existing.baseCurrency !== command.baseCurrency) {
        const postedJournals = await tx.financeJournalEntry.count({
          where: { legalEntityId: existing.id, status: { in: ["posted", "reversed"] } },
        });
        if (postedJournals > 0) {
          throw financeConflict(
            "Base currency cannot change after journals have been posted",
            "FINANCE_BASE_CURRENCY_LOCKED",
          );
        }
      }
      if (existing && existing.fiscalYearStartMonth !== command.fiscalYearStartMonth) {
        const periods = await tx.financeFiscalPeriod.count({
          where: { legalEntityId: existing.id },
        });
        if (periods > 0) {
          throw financeConflict(
            "Fiscal year start month cannot change after periods are created",
            "FINANCE_FISCAL_CALENDAR_LOCKED",
          );
        }
      }
      const entity = await tx.financeLegalEntity.upsert({
        where: { companyId: command.companyId },
        create: {
          companyId: command.companyId,
          baseCurrency: command.baseCurrency,
          reportingCurrency: command.reportingCurrency,
          fiscalYearStartMonth: command.fiscalYearStartMonth,
          timezone: command.timezone,
          createdByUserId: command.actorUserId,
          updatedByUserId: command.actorUserId,
        },
        update: {
          baseCurrency: command.baseCurrency,
          reportingCurrency: command.reportingCurrency,
          fiscalYearStartMonth: command.fiscalYearStartMonth,
          timezone: command.timezone,
          updatedByUserId: command.actorUserId,
        },
      });
      await Promise.all([
        tx.financeAuditEvent.create({
          data: {
            legalEntityId: entity.id,
            action: "finance.entity.configured",
            actorUserId: command.actorUserId,
            detailsJson: {
              baseCurrency: command.baseCurrency,
              reportingCurrency: command.reportingCurrency,
              fiscalYearStartMonth: command.fiscalYearStartMonth,
              timezone: command.timezone,
            },
          },
        }),
        enqueueEvent(tx, {
          legalEntityId: entity.id,
          aggregateType: "finance_legal_entity",
          aggregateId: entity.id,
          eventType: "finance.entity.configured",
          payload: { companyId: command.companyId, baseCurrency: command.baseCurrency },
        }),
      ]);
      return entity;
    });
  }

  async listAccounts(companyId: string, page: CursorPage) {
    const rows = await prisma.financeAccount.findMany({
      where: { legalEntity: { companyId } },
      orderBy: [{ code: "asc" }, { id: "asc" }],
      take: page.limit + 1,
      ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
      include: { parent: { select: { id: true, code: true, name: true } } },
    });
    return pageResult(rows, page.limit);
  }

  async createAccount(command: CreateAccountCommand) {
    return prisma.$transaction(async (tx) => {
      const entity = await requireLegalEntity(tx, command.companyId);
      if (command.parentId) {
        const parent = await tx.financeAccount.findFirst({
          where: { id: command.parentId, legalEntityId: entity.id },
        });
        if (!parent) {
          throw financeNotFound("Parent finance account not found", "FINANCE_PARENT_ACCOUNT_NOT_FOUND");
        }
      }
      const account = await tx.financeAccount.create({
        data: {
          legalEntityId: entity.id,
          code: command.code,
          name: command.name,
          type: command.type,
          parentId: command.parentId,
          allowPosting: command.allowPosting,
          isControlAccount: command.isControlAccount,
          currency: command.currency,
          description: command.description,
          metadataJson: json(command.metadata),
        },
      });
      await Promise.all([
        tx.financeAuditEvent.create({
          data: {
            legalEntityId: entity.id,
            action: "finance.account.created",
            actorUserId: command.actorUserId,
            detailsJson: { accountId: account.id, code: account.code, type: account.type },
          },
        }),
        enqueueEvent(tx, {
          legalEntityId: entity.id,
          aggregateType: "finance_account",
          aggregateId: account.id,
          eventType: "finance.account.created",
          payload: { companyId: command.companyId, code: account.code, type: account.type },
        }),
      ]);
      return account;
    });
  }

  async bootstrapChart(command: BootstrapChartCommand) {
    return prisma.$transaction(async (tx) => {
      const entity = await requireLegalEntity(tx, command.companyId);
      const installation = await tx.financeChartTemplateInstallation.findUnique({
        where: {
          legalEntityId_templateCode_templateVersion: {
            legalEntityId: entity.id,
            templateCode: command.templateCode,
            templateVersion: command.templateVersion,
          },
        },
      });
      if (installation) {
        const accounts = await tx.financeAccount.findMany({
          where: {
            legalEntityId: entity.id,
            metadataJson: { path: ["templateCode"], equals: command.templateCode },
          },
          orderBy: { code: "asc" },
        });
        if (accounts.length !== installation.accountCount) {
          throw financeConflict(
            "Installed chart template account set failed integrity validation",
            "FINANCE_CHART_TEMPLATE_INTEGRITY_ERROR",
          );
        }
        return { installation, accounts, idempotent: true };
      }
      const existingAccounts = await tx.financeAccount.count({
        where: { legalEntityId: entity.id },
      });
      if (existingAccounts > 0) {
        throw financeConflict(
          "Standard chart bootstrap requires an empty chart of accounts",
          "FINANCE_CHART_NOT_EMPTY",
        );
      }

      const accountIdByCode = new Map<string, string>();
      const createdAccounts = [];
      for (const templateAccount of command.accounts) {
        const parentId = templateAccount.parentCode
          ? accountIdByCode.get(templateAccount.parentCode)
          : undefined;
        if (templateAccount.parentCode && !parentId) {
          throw financeConflict(
            `Chart template parent ${templateAccount.parentCode} is not defined before ${templateAccount.code}`,
            "FINANCE_CHART_TEMPLATE_INVALID",
          );
        }
        const account = await tx.financeAccount.create({
          data: {
            legalEntityId: entity.id,
            code: templateAccount.code,
            name: templateAccount.name,
            type: templateAccount.type,
            parentId,
            allowPosting: templateAccount.allowPosting,
            isControlAccount: templateAccount.isControlAccount ?? false,
            description: templateAccount.description,
            metadataJson: {
              templateCode: command.templateCode,
              templateVersion: command.templateVersion,
            },
          },
        });
        accountIdByCode.set(account.code, account.id);
        createdAccounts.push(account);
      }

      const installed = await tx.financeChartTemplateInstallation.create({
        data: {
          legalEntityId: entity.id,
          templateCode: command.templateCode,
          templateVersion: command.templateVersion,
          installedByUserId: command.actorUserId,
          accountCount: createdAccounts.length,
          metadataJson: { baseCurrency: entity.baseCurrency },
        },
      });
      await Promise.all([
        tx.financeAuditEvent.create({
          data: {
            legalEntityId: entity.id,
            action: "finance.chart_template.installed",
            actorUserId: command.actorUserId,
            detailsJson: {
              installationId: installed.id,
              templateCode: command.templateCode,
              templateVersion: command.templateVersion,
              accountCount: createdAccounts.length,
            },
          },
        }),
        enqueueEvent(tx, {
          legalEntityId: entity.id,
          aggregateType: "finance_chart_template",
          aggregateId: installed.id,
          eventType: "finance.chart_template.installed",
          payload: {
            companyId: command.companyId,
            templateCode: command.templateCode,
            templateVersion: command.templateVersion,
            accountCount: createdAccounts.length,
          },
        }),
      ]);
      return { installation: installed, accounts: createdAccounts, idempotent: false };
    });
  }

  async listPeriods(companyId: string, page: CursorPage) {
    const rows = await prisma.financeFiscalPeriod.findMany({
      where: { legalEntity: { companyId } },
      orderBy: [{ startDate: "desc" }, { id: "desc" }],
      take: page.limit + 1,
      ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
    });
    return pageResult(rows, page.limit);
  }

  async createPeriod(command: CreatePeriodCommand) {
    return prisma.$transaction(async (tx) => {
      const entity = await requireLegalEntity(tx, command.companyId);
      const overlap = await tx.financeFiscalPeriod.findFirst({
        where: {
          legalEntityId: entity.id,
          startDate: { lte: command.endDate },
          endDate: { gte: command.startDate },
        },
      });
      if (overlap) {
        throw financeConflict(
          `Fiscal period overlaps ${overlap.name}`,
          "FINANCE_PERIOD_OVERLAP",
        );
      }
      const period = await tx.financeFiscalPeriod.create({
        data: {
          legalEntityId: entity.id,
          fiscalYear: command.fiscalYear,
          periodNumber: command.periodNumber,
          name: command.name,
          startDate: command.startDate,
          endDate: command.endDate,
        },
      });
      await Promise.all([
        tx.financeAuditEvent.create({
          data: {
            legalEntityId: entity.id,
            action: "finance.period.created",
            actorUserId: command.actorUserId,
            detailsJson: {
              periodId: period.id,
              fiscalYear: period.fiscalYear,
              periodNumber: period.periodNumber,
            },
          },
        }),
        enqueueEvent(tx, {
          legalEntityId: entity.id,
          aggregateType: "finance_period",
          aggregateId: period.id,
          eventType: "finance.period.created",
          payload: { companyId: command.companyId, fiscalYear: period.fiscalYear, periodNumber: period.periodNumber },
        }),
      ]);
      return period;
    });
  }

  async changePeriodStatus(command: ChangePeriodStatusCommand) {
    return prisma.$transaction(async (tx) => {
      const entity = await requireLegalEntity(tx, command.companyId);
      const period = await tx.financeFiscalPeriod.findFirst({
        where: { id: command.periodId, legalEntityId: entity.id },
      });
      if (!period) {
        throw financeNotFound("Fiscal period not found", "FINANCE_PERIOD_NOT_FOUND");
      }
      if (command.status === "closed") {
        const drafts = await tx.financeJournalEntry.count({
          where: {
            legalEntityId: entity.id,
            status: "draft",
            postingDate: { gte: period.startDate, lte: period.endDate },
          },
        });
        if (drafts > 0) {
          throw financeConflict(
            `Cannot close period with ${drafts} draft journal(s)`,
            "FINANCE_PERIOD_HAS_DRAFTS",
          );
        }
      }
      const now = new Date();
      const updated = await tx.financeFiscalPeriod.update({
        where: { id: period.id },
        data: {
          status: command.status,
          ...(command.status === "closed"
            ? { closedAt: now, closedByUserId: command.actorUserId }
            : command.status === "open"
              ? { reopenedAt: now, reopenedByUserId: command.actorUserId }
              : {}),
        },
      });
      await Promise.all([
        tx.financeAuditEvent.create({
          data: {
            legalEntityId: entity.id,
            action: "finance.period.status_changed",
            actorUserId: command.actorUserId,
            detailsJson: { periodId: period.id, from: period.status, to: command.status },
          },
        }),
        enqueueEvent(tx, {
          legalEntityId: entity.id,
          aggregateType: "finance_period",
          aggregateId: period.id,
          eventType: "finance.period.status_changed",
          payload: { companyId: command.companyId, from: period.status, to: command.status },
        }),
      ]);
      return updated;
    });
  }

  async listJournals(companyId: string, page: CursorPage) {
    const rows = await prisma.financeJournalEntry.findMany({
      where: { legalEntity: { companyId } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: page.limit + 1,
      ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
      include: {
        document: true,
        _count: { select: { lines: true } },
      },
    });
    return pageResult(rows, page.limit);
  }

  async getJournal(companyId: string, journalId: string) {
    const journal = await prisma.financeJournalEntry.findFirst({
      where: { id: journalId, legalEntity: { companyId } },
      include: journalInclude,
    });
    if (!journal) {
      throw financeNotFound("Finance journal not found", "FINANCE_JOURNAL_NOT_FOUND");
    }
    return journal;
  }

  async createDraftJournal(command: CreateJournalCommand) {
    return prisma.$transaction(async (tx) => {
      const entity = await requireLegalEntity(tx, command.companyId);
      const duplicate = await tx.financeDocument.findUnique({
        where: {
          legalEntityId_idempotencyKey: {
            legalEntityId: entity.id,
            idempotencyKey: command.idempotencyKey,
          },
        },
        include: { journalEntry: { include: journalInclude } },
      });
      if (duplicate?.journalEntry) return duplicate.journalEntry;

      await requireOpenPeriod(tx, entity.id, command.postingDate);
      const prepared = prepareJournal({
        currency: command.currency,
        baseCurrency: entity.baseCurrency,
        fxRate: command.fxRate,
        lines: command.lines,
      });
      const accountIds = [...new Set(prepared.lines.map((line) => line.accountId))];
      const accounts = await tx.financeAccount.findMany({
        where: { id: { in: accountIds }, legalEntityId: entity.id },
      });
      if (accounts.length !== accountIds.length) {
        throw financeNotFound(
          "One or more journal accounts do not belong to this finance entity",
          "FINANCE_ACCOUNT_SCOPE_MISMATCH",
        );
      }
      const invalidAccount = accounts.find(
        (account) => account.status !== "active" || !account.allowPosting || account.isControlAccount,
      );
      if (invalidAccount) {
        throw financeConflict(
          `Account ${invalidAccount.code} does not allow manual posting`,
          "FINANCE_ACCOUNT_NOT_POSTABLE",
        );
      }
      const currencyMismatch = accounts.find(
        (account) => account.currency && account.currency !== prepared.currency,
      );
      if (currencyMismatch) {
        throw financeConflict(
          `Account ${currencyMismatch.code} only accepts ${currencyMismatch.currency}`,
          "FINANCE_ACCOUNT_CURRENCY_MISMATCH",
        );
      }

      const [documentNumber, journalNumber] = await Promise.all([
        allocateNumber(tx, entity.id, "manual_document", "FD-"),
        allocateNumber(tx, entity.id, "general_journal", "GJ-"),
      ]);
      const document = await tx.financeDocument.create({
        data: {
          legalEntityId: entity.id,
          documentNumber,
          type: "manual_journal",
          documentDate: command.documentDate,
          postingDate: command.postingDate,
          currency: prepared.currency,
          totalAmount: prepared.totalDebit,
          baseAmount: prepared.totalDebitBase,
          fxRate: prepared.fxRate,
          fxRateAsOf: command.fxRateAsOf,
          sourceType: command.sourceType,
          sourceId: command.sourceId,
          sourceEventId: command.sourceEventId,
          idempotencyKey: command.idempotencyKey,
          description: command.description,
          metadataJson: json(command.metadata),
          createdByUserId: command.actorUserId,
        },
      });
      const journal = await tx.financeJournalEntry.create({
        data: {
          legalEntityId: entity.id,
          documentId: document.id,
          journalNumber,
          postingDate: command.postingDate,
          description: command.description,
          totalDebitBase: prepared.totalDebitBase,
          totalCreditBase: prepared.totalCreditBase,
          lines: {
            create: prepared.lines.map((line) => ({
              lineNumber: line.lineNumber,
              accountId: line.accountId,
              debitAmount: line.debitAmount,
              creditAmount: line.creditAmount,
              currency: prepared.currency,
              fxRate: prepared.fxRate,
              debitBase: line.debitBase,
              creditBase: line.creditBase,
              description: line.description,
              orderId: line.orderId,
              orderLegId: line.orderLegId,
              customerEntityId: line.customerEntityId,
              branchId: line.branchId,
              warehouseId: line.warehouseId,
              carrierProviderId: line.carrierProviderId,
              costCenterCode: line.costCenterCode,
              profitCenterCode: line.profitCenterCode,
              metadataJson: json(line.metadata),
            })),
          },
        },
        include: journalInclude,
      });
      await Promise.all([
        tx.financeAuditEvent.create({
          data: {
            legalEntityId: entity.id,
            documentId: document.id,
            journalEntryId: journal.id,
            action: "finance.journal.draft_created",
            actorUserId: command.actorUserId,
            detailsJson: { documentNumber, journalNumber, idempotencyKey: command.idempotencyKey },
          },
        }),
        enqueueEvent(tx, {
          legalEntityId: entity.id,
          aggregateType: "finance_journal",
          aggregateId: journal.id,
          eventType: "finance.journal.draft_created",
          payload: { companyId: command.companyId, documentNumber, journalNumber },
        }),
      ]);
      return journal;
    });
  }

  async postJournal(companyId: string, journalId: string, actorUserId: string) {
    return prisma.$transaction(async (tx) => {
      const journal = await findJournal(tx, companyId, journalId);
      if (journal.status === "posted") return journal;
      if (journal.status !== "draft") {
        throw financeConflict(`Journal is ${journal.status}`, "FINANCE_JOURNAL_NOT_DRAFT");
      }
      await requireOpenPeriod(tx, journal.legalEntityId, journal.postingDate);
      const invalidAccount = journal.lines.find(
        (line) =>
          line.account.status !== "active" ||
          !line.account.allowPosting ||
          line.account.isControlAccount ||
          (line.account.currency && line.account.currency !== journal.document.currency),
      );
      if (invalidAccount) {
        throw financeConflict(
          `Account ${invalidAccount.account.code} is no longer valid for this journal`,
          "FINANCE_ACCOUNT_NOT_POSTABLE",
        );
      }
      const prepared = prepareJournal({
        currency: journal.document.currency,
        baseCurrency: journal.legalEntity.baseCurrency,
        fxRate: journal.document.fxRate.toString(),
        lines: journal.lines.map((line) => ({
          accountId: line.accountId,
          debitAmount: line.debitAmount.toString(),
          creditAmount: line.creditAmount.toString(),
        })),
      });
      if (
        !prepared.totalDebitBase.eq(journal.totalDebitBase.toString()) ||
        !prepared.totalCreditBase.eq(journal.totalCreditBase.toString())
      ) {
        throw financeConflict("Stored journal totals failed integrity validation", "FINANCE_LEDGER_INTEGRITY_ERROR");
      }
      const now = new Date();
      await Promise.all([
        tx.financeJournalEntry.update({
          where: { id: journal.id },
          data: { status: "posted", postedAt: now, postedByUserId: actorUserId },
        }),
        tx.financeDocument.update({
          where: { id: journal.documentId },
          data: { status: "posted", postedAt: now, postedByUserId: actorUserId },
        }),
        tx.financeAuditEvent.create({
          data: {
            legalEntityId: journal.legalEntityId,
            documentId: journal.documentId,
            journalEntryId: journal.id,
            action: "finance.journal.posted",
            actorUserId,
            detailsJson: { journalNumber: journal.journalNumber },
          },
        }),
        enqueueEvent(tx, {
          legalEntityId: journal.legalEntityId,
          aggregateType: "finance_journal",
          aggregateId: journal.id,
          eventType: "finance.journal.posted",
          payload: { companyId, journalNumber: journal.journalNumber, postingDate: journal.postingDate.toISOString() },
        }),
      ]);
      return tx.financeJournalEntry.findUniqueOrThrow({
        where: { id: journal.id },
        include: journalInclude,
      });
    });
  }

  async reverseJournal(command: ReverseJournalCommand) {
    return prisma.$transaction(async (tx) => {
      const original = await findJournal(tx, command.companyId, command.journalId);
      const existing = await tx.financeDocument.findUnique({
        where: {
          legalEntityId_idempotencyKey: {
            legalEntityId: original.legalEntityId,
            idempotencyKey: command.idempotencyKey,
          },
        },
        include: { journalEntry: { include: journalInclude } },
      });
      if (existing?.journalEntry) return existing.journalEntry;
      if (original.status !== "posted") {
        throw financeConflict("Only posted journals can be reversed", "FINANCE_JOURNAL_NOT_POSTED");
      }
      const priorReversal = await tx.financeJournalEntry.findFirst({
        where: { reversalOfId: original.id },
      });
      if (priorReversal) {
        throw financeConflict("Journal already has a reversal", "FINANCE_JOURNAL_ALREADY_REVERSED");
      }
      await requireOpenPeriod(tx, original.legalEntityId, command.postingDate);
      const [documentNumber, journalNumber] = await Promise.all([
        allocateNumber(tx, original.legalEntityId, "reversal_document", "RV-"),
        allocateNumber(tx, original.legalEntityId, "general_journal", "GJ-"),
      ]);
      const now = new Date();
      const document = await tx.financeDocument.create({
        data: {
          legalEntityId: original.legalEntityId,
          documentNumber,
          type: "adjustment",
          status: "posted",
          documentDate: command.postingDate,
          postingDate: command.postingDate,
          currency: original.document.currency,
          totalAmount: original.document.totalAmount,
          baseAmount: original.document.baseAmount,
          fxRate: original.document.fxRate,
          fxRateAsOf: original.document.fxRateAsOf,
          sourceType: "finance_journal_reversal",
          sourceId: original.id,
          idempotencyKey: command.idempotencyKey,
          description: command.reason,
          createdByUserId: command.actorUserId,
          postedByUserId: command.actorUserId,
          postedAt: now,
          reversalOfId: original.documentId,
        },
      });
      const reversal = await tx.financeJournalEntry.create({
        data: {
          legalEntityId: original.legalEntityId,
          documentId: document.id,
          journalNumber,
          status: "posted",
          postingDate: command.postingDate,
          description: command.reason,
          totalDebitBase: original.totalCreditBase,
          totalCreditBase: original.totalDebitBase,
          postedAt: now,
          postedByUserId: command.actorUserId,
          reversalOfId: original.id,
          lines: {
            create: original.lines.map((line) => ({
              lineNumber: line.lineNumber,
              accountId: line.accountId,
              debitAmount: line.creditAmount,
              creditAmount: line.debitAmount,
              currency: line.currency,
              fxRate: line.fxRate,
              debitBase: line.creditBase,
              creditBase: line.debitBase,
              description: line.description,
              orderId: line.orderId,
              orderLegId: line.orderLegId,
              customerEntityId: line.customerEntityId,
              branchId: line.branchId,
              warehouseId: line.warehouseId,
              carrierProviderId: line.carrierProviderId,
              costCenterCode: line.costCenterCode,
              profitCenterCode: line.profitCenterCode,
              metadataJson: line.metadataJson ?? undefined,
            })),
          },
        },
        include: journalInclude,
      });
      await Promise.all([
        tx.financeJournalEntry.update({
          where: { id: original.id },
          data: { status: "reversed", reversedAt: now, reversedByUserId: command.actorUserId },
        }),
        tx.financeDocument.update({
          where: { id: original.documentId },
          data: { status: "reversed", reversedAt: now, reversedByUserId: command.actorUserId },
        }),
        tx.financeAuditEvent.create({
          data: {
            legalEntityId: original.legalEntityId,
            documentId: document.id,
            journalEntryId: reversal.id,
            action: "finance.journal.reversed",
            actorUserId: command.actorUserId,
            detailsJson: { originalJournalId: original.id, reason: command.reason },
          },
        }),
        enqueueEvent(tx, {
          legalEntityId: original.legalEntityId,
          aggregateType: "finance_journal",
          aggregateId: original.id,
          eventType: "finance.journal.reversed",
          payload: { companyId: command.companyId, reversalJournalId: reversal.id, reason: command.reason },
        }),
      ]);
      return reversal;
    });
  }

  async getTrialBalance(companyId: string, from: Date, to: Date) {
    const entity = await prisma.financeLegalEntity.findUnique({ where: { companyId } });
    if (!entity) {
      throw financeNotFound(
        "Finance legal entity is not configured for this company",
        "FINANCE_ENTITY_NOT_CONFIGURED",
      );
    }
    const balances = await prisma.financeJournalLine.groupBy({
      by: ["accountId"],
      where: {
        journalEntry: {
          legalEntityId: entity.id,
          status: { in: ["posted", "reversed"] },
          postingDate: { gte: from, lte: to },
        },
      },
      _sum: { debitBase: true, creditBase: true },
      orderBy: { accountId: "asc" },
    });
    const accounts = await prisma.financeAccount.findMany({
      where: { id: { in: balances.map((row) => row.accountId) }, legalEntityId: entity.id },
      select: { id: true, code: true, name: true, type: true },
    });
    const accountById = new Map(accounts.map((account) => [account.id, account]));
    let totalDebit = new Prisma.Decimal(0);
    let totalCredit = new Prisma.Decimal(0);
    const rows = balances.map((balance) => {
      const debit = balance._sum.debitBase ?? new Prisma.Decimal(0);
      const credit = balance._sum.creditBase ?? new Prisma.Decimal(0);
      totalDebit = totalDebit.add(debit);
      totalCredit = totalCredit.add(credit);
      return { account: accountById.get(balance.accountId), debit, credit, balance: debit.sub(credit) };
    });
    return {
      baseCurrency: entity.baseCurrency,
      from,
      to,
      totalDebit,
      totalCredit,
      balanced: totalDebit.eq(totalCredit),
      rows,
    };
  }

  async listPostingRules(companyId: string, page: CursorPage) {
    const rows = await prisma.financePostingRule.findMany({
      where: { legalEntity: { companyId } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: page.limit + 1,
      ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
      include: postingRuleInclude,
    });
    return pageResult(rows, page.limit);
  }

  async getPostingRule(companyId: string, ruleId: string) {
    const rule = await prisma.financePostingRule.findFirst({
      where: { id: ruleId, legalEntity: { companyId } },
      include: postingRuleInclude,
    });
    if (!rule) {
      throw financeNotFound("Finance posting rule not found", "FINANCE_POSTING_RULE_NOT_FOUND");
    }
    return rule;
  }

  async createPostingRule(command: CreatePostingRuleCommand) {
    return prisma.$transaction(async (tx) => {
      const entity = await requireLegalEntity(tx, command.companyId);
      const existing = await tx.financePostingRule.findFirst({
        where: { legalEntityId: entity.id, code: command.code },
      });
      if (existing) {
        throw financeConflict(
          `Posting rule ${command.code} already exists; create a new version instead`,
          "FINANCE_POSTING_RULE_EXISTS",
        );
      }
      const rule = await createPostingRuleTx(tx, entity.id, command, 1);
      await Promise.all([
        tx.financeAuditEvent.create({
          data: {
            legalEntityId: entity.id,
            action: "finance.posting_rule.created",
            actorUserId: command.actorUserId,
            detailsJson: { ruleId: rule.id, code: rule.code, version: rule.version },
          },
        }),
        enqueueEvent(tx, {
          legalEntityId: entity.id,
          aggregateType: "finance_posting_rule",
          aggregateId: rule.id,
          eventType: "finance.posting_rule.created",
          payload: { companyId: command.companyId, code: rule.code, version: rule.version },
        }),
      ]);
      return rule;
    });
  }

  async createPostingRuleVersion(command: CreatePostingRuleVersionCommand) {
    return prisma.$transaction(async (tx) => {
      const entity = await requireLegalEntity(tx, command.companyId);
      const baseRule = await tx.financePostingRule.findFirst({
        where: { id: command.ruleId, legalEntityId: entity.id },
      });
      if (!baseRule) {
        throw financeNotFound("Finance posting rule not found", "FINANCE_POSTING_RULE_NOT_FOUND");
      }
      if (command.code !== baseRule.code) {
        throw financeConflict(
          "Posting rule code cannot change between versions",
          "FINANCE_POSTING_RULE_CODE_LOCKED",
        );
      }
      const latest = await tx.financePostingRule.findFirst({
        where: { legalEntityId: entity.id, code: baseRule.code },
        orderBy: { version: "desc" },
      });
      const version = (latest?.version ?? 0) + 1;
      await tx.financePostingRule.updateMany({
        where: { legalEntityId: entity.id, code: baseRule.code, status: "active" },
        data: { status: "inactive" },
      });
      const rule = await createPostingRuleTx(tx, entity.id, command, version);
      await Promise.all([
        tx.financeAuditEvent.create({
          data: {
            legalEntityId: entity.id,
            action: "finance.posting_rule.version_created",
            actorUserId: command.actorUserId,
            detailsJson: { ruleId: rule.id, code: rule.code, version: rule.version, previousRuleId: baseRule.id },
          },
        }),
        enqueueEvent(tx, {
          legalEntityId: entity.id,
          aggregateType: "finance_posting_rule",
          aggregateId: rule.id,
          eventType: "finance.posting_rule.version_created",
          payload: { companyId: command.companyId, code: rule.code, version: rule.version },
        }),
      ]);
      return rule;
    });
  }

  async changePostingRuleStatus(
    companyId: string,
    ruleId: string,
    actorUserId: string,
    status: "active" | "inactive",
  ) {
    return prisma.$transaction(async (tx) => {
      const entity = await requireLegalEntity(tx, companyId);
      const rule = await tx.financePostingRule.findFirst({
        where: { id: ruleId, legalEntityId: entity.id },
      });
      if (!rule) {
        throw financeNotFound("Finance posting rule not found", "FINANCE_POSTING_RULE_NOT_FOUND");
      }
      if (rule.status === status) {
        return tx.financePostingRule.findUniqueOrThrow({
          where: { id: rule.id },
          include: postingRuleInclude,
        });
      }
      if (status === "active") {
        await tx.financePostingRule.updateMany({
          where: { legalEntityId: entity.id, code: rule.code, status: "active", id: { not: rule.id } },
          data: { status: "inactive" },
        });
      }
      const updated = await tx.financePostingRule.update({
        where: { id: rule.id },
        data: { status },
        include: postingRuleInclude,
      });
      await Promise.all([
        tx.financeAuditEvent.create({
          data: {
            legalEntityId: entity.id,
            action: "finance.posting_rule.status_changed",
            actorUserId,
            detailsJson: { ruleId: rule.id, code: rule.code, version: rule.version, from: rule.status, to: status },
          },
        }),
        enqueueEvent(tx, {
          legalEntityId: entity.id,
          aggregateType: "finance_posting_rule",
          aggregateId: rule.id,
          eventType: "finance.posting_rule.status_changed",
          payload: { companyId, code: rule.code, version: rule.version, from: rule.status, to: status },
        }),
      ]);
      return updated;
    });
  }

  async ingestSourceEvent(command: IngestFinanceSourceEventCommand) {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.financeSourceEvent.findUnique({
        where: {
          companyId_sourceEventId: {
            companyId: command.event.companyId,
            sourceEventId: command.event.sourceEventId,
          },
        },
      });
      if (existing) {
        if (existing.payloadHash !== command.payloadHash) {
          throw financeConflict(
            "Source event ID was reused with a different payload",
            "FINANCE_SOURCE_EVENT_IDEMPOTENCY_CONFLICT",
          );
        }
        return { event: existing, idempotent: true };
      }
      const entity = await tx.financeLegalEntity.findUnique({
        where: { companyId: command.event.companyId },
        select: { id: true },
      });
      const event = await tx.financeSourceEvent.create({
        data: {
          companyId: command.event.companyId,
          legalEntityId: entity?.id ?? null,
          sourceEventId: command.event.sourceEventId,
          sourceType: command.event.sourceType,
          eventType: command.event.eventType,
          sourceId: command.event.sourceId,
          schemaVersion: command.event.schemaVersion,
          occurredAt: command.event.occurredAt,
          postingDate: command.event.postingDate,
          payloadHash: command.payloadHash,
          payloadJson: sourceEventJson(command.event),
        },
      });
      return { event, idempotent: false };
    });
  }

  async processSourceEvent(sourceEventRecordId: string) {
    try {
      return await prisma.$transaction(async (tx) => {
        const sourceRecord = await tx.financeSourceEvent.findUnique({
          where: { id: sourceEventRecordId },
        });
        if (!sourceRecord) {
          throw financeNotFound("Finance source event not found", "FINANCE_SOURCE_EVENT_NOT_FOUND");
        }
        if (sourceRecord.status === "posted") {
          return { event: sourceRecord, idempotent: true };
        }
        const event = normalizeFinanceSourceEvent(
          sourceRecord.payloadJson as Parameters<typeof normalizeFinanceSourceEvent>[0],
        );
        if (financeSourceEventHash(event) !== sourceRecord.payloadHash) {
          throw financeConflict(
            "Stored source event failed payload integrity validation",
            "FINANCE_SOURCE_EVENT_INTEGRITY_ERROR",
          );
        }
        const entity = await requireLegalEntity(tx, event.companyId);
        if (event.currency !== entity.baseCurrency && !event.fxRateAsOf) {
          throw financeConflict(
            `Foreign-currency event ${event.currency} requires an immutable FX snapshot`,
            "FINANCE_SOURCE_EVENT_FX_SNAPSHOT_REQUIRED",
          );
        }
        await requireOpenPeriod(tx, entity.id, event.postingDate);

        const rules = await tx.financePostingRule.findMany({
          where: {
            legalEntityId: entity.id,
            sourceType: event.sourceType,
            eventType: event.eventType,
            status: "active",
            AND: [
              { OR: [{ validFrom: null }, { validFrom: { lte: event.occurredAt } }] },
              { OR: [{ validTo: null }, { validTo: { gte: event.occurredAt } }] },
            ],
          },
          orderBy: [{ priority: "desc" }, { version: "desc" }, { code: "asc" }, { id: "asc" }],
          include: {
            lines: {
              orderBy: { lineNumber: "asc" },
              include: { account: true },
            },
          },
        });
        const matching = rules.filter((rule) => postingRuleMatches(event, rule.conditionsJson));
        if (matching.length === 0) {
          throw financeConflict(
            `No active posting rule matched ${event.sourceType}:${event.eventType}`,
            "FINANCE_POSTING_RULE_UNRESOLVED",
          );
        }
        const highestPriority = matching[0].priority;
        const highest = matching.filter((rule) => rule.priority === highestPriority);
        if (highest.length !== 1) {
          throw financeConflict(
            `Multiple posting rules matched at priority ${highestPriority}`,
            "FINANCE_POSTING_RULE_AMBIGUOUS",
          );
        }
        const rule = highest[0];
        const invalidAccount = rule.lines.find(
          (line) =>
            line.account.status !== "active" ||
            !line.account.allowPosting ||
            (line.account.currency && line.account.currency !== event.currency),
        );
        if (invalidAccount) {
          throw financeConflict(
            `Account ${invalidAccount.account.code} is not available for automatic posting`,
            "FINANCE_ACCOUNT_NOT_POSTABLE",
          );
        }
        const descriptionContext = {
          sourceId: event.sourceId,
          sourceEventId: event.sourceEventId,
          currency: event.currency,
          ...event.dimensions,
          ...event.attributes,
        };
        const prepared = prepareJournal({
          currency: event.currency,
          baseCurrency: entity.baseCurrency,
          fxRate: event.fxRate,
          lines: rule.lines.map((line) => {
            const amount = event.amounts[line.amountExpression as keyof typeof event.amounts];
            if (!amount) {
              throw financeConflict(
                `Posting rule requires missing amount ${line.amountExpression}`,
                "FINANCE_SOURCE_EVENT_AMOUNT_MISSING",
              );
            }
            return {
              accountId: line.accountId,
              debitAmount: line.side === "debit" ? amount : "0",
              creditAmount: line.side === "credit" ? amount : "0",
              description: renderPostingDescription(line.descriptionTemplate, descriptionContext) ?? undefined,
              ...event.dimensions,
              metadata: {
                postingRuleId: rule.id,
                postingRuleCode: rule.code,
                postingRuleVersion: rule.version,
                amountKey: line.amountExpression,
              },
            };
          }),
        });
        const [documentNumber, journalNumber] = await Promise.all([
          allocateNumber(tx, entity.id, `${event.sourceType}_document`, "AD-"),
          allocateNumber(tx, entity.id, "general_journal", "GJ-"),
        ]);
        const now = new Date();
        const actorUserId = event.actorUserId ?? entity.createdByUserId;
        const document = await tx.financeDocument.create({
          data: {
            legalEntityId: entity.id,
            documentNumber,
            type: documentTypeForSource(event.sourceType, event.eventType),
            status: "posted",
            documentDate: event.documentDate,
            postingDate: event.postingDate,
            currency: prepared.currency,
            totalAmount: prepared.totalDebit,
            baseAmount: prepared.totalDebitBase,
            fxRate: prepared.fxRate,
            fxRateAsOf: event.fxRateAsOf,
            sourceType: event.sourceType,
            sourceId: event.sourceId,
            sourceEventId: event.sourceEventId,
            idempotencyKey: `source-event:${event.sourceEventId}`,
            description: event.description,
            metadataJson: sourceEventJson({
              ...event.metadata,
              postingRuleId: rule.id,
              postingRuleCode: rule.code,
              postingRuleVersion: rule.version,
            }),
            createdByUserId: actorUserId,
            postedByUserId: actorUserId,
            postedAt: now,
          },
        });
        const journal = await tx.financeJournalEntry.create({
          data: {
            legalEntityId: entity.id,
            documentId: document.id,
            journalNumber,
            status: "posted",
            postingDate: event.postingDate,
            description: event.description,
            totalDebitBase: prepared.totalDebitBase,
            totalCreditBase: prepared.totalCreditBase,
            postedAt: now,
            postedByUserId: actorUserId,
            lines: {
              create: prepared.lines.map((line) => ({
                lineNumber: line.lineNumber,
                accountId: line.accountId,
                debitAmount: line.debitAmount,
                creditAmount: line.creditAmount,
                currency: prepared.currency,
                fxRate: prepared.fxRate,
                debitBase: line.debitBase,
                creditBase: line.creditBase,
                description: line.description,
                orderId: line.orderId,
                orderLegId: line.orderLegId,
                customerEntityId: line.customerEntityId,
                branchId: line.branchId,
                warehouseId: line.warehouseId,
                carrierProviderId: line.carrierProviderId,
                costCenterCode: line.costCenterCode,
                profitCenterCode: line.profitCenterCode,
                metadataJson: json(line.metadata),
              })),
            },
          },
          include: journalInclude,
        });
        await projectFinanceSubledgerEvent(tx, entity.id, event);
        const postedEvent = await tx.financeSourceEvent.update({
          where: { id: sourceRecord.id },
          data: {
            legalEntityId: entity.id,
            status: "posted",
            resolvedRuleId: rule.id,
            financeDocumentId: document.id,
            financeJournalEntryId: journal.id,
            attempts: { increment: 1 },
            claimedAt: null,
            claimedBy: null,
            lastErrorCode: null,
            lastErrorMessage: null,
            processedAt: now,
          },
        });
        await Promise.all([
          tx.financeAuditEvent.create({
            data: {
              legalEntityId: entity.id,
              documentId: document.id,
              journalEntryId: journal.id,
              action: "finance.source_event.posted",
              actorUserId,
              detailsJson: {
                financeSourceEventId: sourceRecord.id,
                sourceEventId: event.sourceEventId,
                sourceType: event.sourceType,
                eventType: event.eventType,
                postingRuleId: rule.id,
              },
            },
          }),
          enqueueEvent(tx, {
            legalEntityId: entity.id,
            aggregateType: "finance_source_event",
            aggregateId: sourceRecord.id,
            eventType: "finance.source_event.posted",
            payload: {
              companyId: event.companyId,
              sourceEventId: event.sourceEventId,
              documentId: document.id,
              journalId: journal.id,
            },
          }),
        ]);
        return { event: postedEvent, document, journal, rule, idempotent: false };
      });
    } catch (error) {
      if (!(error instanceof FinanceError)) throw error;
      const updated = await prisma.financeSourceEvent.updateMany({
        where: { id: sourceEventRecordId, status: { not: "posted" } },
        data: {
          status: "exception",
          attempts: { increment: 1 },
          claimedAt: null,
          claimedBy: null,
          lastErrorCode: error.code,
          lastErrorMessage: error.message.slice(0, 1000),
          processedAt: new Date(),
        },
      });
      if (updated.count === 0) throw error;
      return {
        event: await prisma.financeSourceEvent.findUniqueOrThrow({ where: { id: sourceEventRecordId } }),
        exception: true,
      };
    }
  }

  async listSourceEvents(
    companyId: string,
    page: CursorPage,
    status?: "pending" | "processing" | "posted" | "exception",
  ) {
    const rows = await prisma.financeSourceEvent.findMany({
      where: { companyId, ...(status ? { status } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: page.limit + 1,
      ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
      include: {
        resolvedRule: { select: { id: true, code: true, name: true, version: true } },
        financeDocument: { select: { id: true, documentNumber: true, status: true } },
        financeJournalEntry: { select: { id: true, journalNumber: true, status: true } },
      },
    });
    return pageResult(rows, page.limit);
  }

  async retrySourceEvent(companyId: string, sourceEventRecordId: string, actorUserId: string) {
    return prisma.$transaction(async (tx) => {
      const event = await tx.financeSourceEvent.findFirst({
        where: { id: sourceEventRecordId, companyId },
      });
      if (!event) {
        throw financeNotFound("Finance source event not found", "FINANCE_SOURCE_EVENT_NOT_FOUND");
      }
      if (event.status !== "exception") {
        throw financeConflict("Only exception events can be retried", "FINANCE_SOURCE_EVENT_NOT_EXCEPTION");
      }
      const updated = await tx.financeSourceEvent.update({
        where: { id: event.id },
        data: {
          status: "pending",
          nextAttemptAt: new Date(),
          claimedAt: null,
          claimedBy: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          processedAt: null,
        },
      });
      if (event.legalEntityId) {
        await tx.financeAuditEvent.create({
          data: {
            legalEntityId: event.legalEntityId,
            action: "finance.source_event.retry_requested",
            actorUserId,
            detailsJson: { financeSourceEventId: event.id, sourceEventId: event.sourceEventId },
          },
        });
      }
      return updated;
    });
  }
}

export const prismaFinanceRepository = new PrismaFinanceRepository();
