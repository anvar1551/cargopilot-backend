import {
  assertFinanceCurrency,
  type JournalLineInput,
} from "../domain/ledger";
import { financeBadRequest } from "../domain/finance.errors";
import { getChartTemplate } from "../domain/chart-template";
import {
  assertPostingEvent,
  assertPostingRuleLines,
  type PostingRuleLineInput,
} from "../domain/posting-rules";
import type {
  CreateAccountCommand,
  FinanceRepositoryPort,
} from "./finance.port";
import {
  financeSourceEventHash,
  normalizeFinanceSourceEvent,
  type CanonicalFinanceSourceEventInput,
} from "../domain/source-event";

export class FinanceService {
  constructor(private readonly repository: FinanceRepositoryPort) {}

  getLegalEntity(companyId: string) {
    return this.repository.getLegalEntity(companyId);
  }

  configureLegalEntity(input: {
    companyId: string;
    actorUserId: string;
    baseCurrency: string;
    reportingCurrency?: string | null;
    fiscalYearStartMonth: number;
    timezone: string;
  }) {
    const baseCurrency = assertFinanceCurrency(input.baseCurrency);
    const reportingCurrency = input.reportingCurrency
      ? assertFinanceCurrency(input.reportingCurrency)
      : null;
    return this.repository.configureLegalEntity({
      ...input,
      baseCurrency,
      reportingCurrency,
    });
  }

  listAccounts(companyId: string, page: { cursor?: string; limit: number }) {
    return this.repository.listAccounts(companyId, page);
  }

  createAccount(input: CreateAccountCommand) {
    const currency = input.currency ? assertFinanceCurrency(input.currency) : null;
    return this.repository.createAccount({ ...input, currency });
  }

  bootstrapChart(input: {
    companyId: string;
    actorUserId: string;
    templateCode: string;
    templateVersion: number;
  }) {
    const accounts = getChartTemplate(input.templateCode, input.templateVersion);
    if (!accounts) {
      throw financeBadRequest(
        `Unknown chart template ${input.templateCode} v${input.templateVersion}`,
        "FINANCE_CHART_TEMPLATE_UNKNOWN",
      );
    }
    return this.repository.bootstrapChart({ ...input, accounts });
  }

  listPeriods(companyId: string, page: { cursor?: string; limit: number }) {
    return this.repository.listPeriods(companyId, page);
  }

  createPeriod(input: {
    companyId: string;
    actorUserId: string;
    fiscalYear: number;
    periodNumber: number;
    name: string;
    startDate: Date;
    endDate: Date;
  }) {
    if (input.startDate > input.endDate) {
      throw financeBadRequest(
        "Fiscal period startDate must be on or before endDate",
        "FINANCE_INVALID_PERIOD_RANGE",
      );
    }
    return this.repository.createPeriod(input);
  }

  changePeriodStatus(input: {
    companyId: string;
    actorUserId: string;
    periodId: string;
    status: "open" | "restricted" | "closed";
  }) {
    return this.repository.changePeriodStatus(input);
  }

  listJournals(companyId: string, page: { cursor?: string; limit: number }) {
    return this.repository.listJournals(companyId, page);
  }

  getJournal(companyId: string, journalId: string) {
    return this.repository.getJournal(companyId, journalId);
  }

  createDraftJournal(input: {
    companyId: string;
    actorUserId: string;
    idempotencyKey: string;
    documentDate: Date;
    postingDate: Date;
    currency: string;
    fxRate: string;
    fxRateAsOf?: Date | null;
    description?: string | null;
    sourceType?: string | null;
    sourceId?: string | null;
    sourceEventId?: string | null;
    metadata?: Record<string, unknown>;
    lines: JournalLineInput[];
  }) {
    const currency = assertFinanceCurrency(input.currency);
    return this.repository.createDraftJournal({ ...input, currency });
  }

  postJournal(companyId: string, journalId: string, actorUserId: string) {
    return this.repository.postJournal(companyId, journalId, actorUserId);
  }

  reverseJournal(input: {
    companyId: string;
    actorUserId: string;
    journalId: string;
    postingDate: Date;
    reason: string;
    idempotencyKey: string;
  }) {
    return this.repository.reverseJournal(input);
  }

  getTrialBalance(companyId: string, from: Date, to: Date) {
    if (from > to) {
      throw financeBadRequest("from must be on or before to", "FINANCE_INVALID_DATE_RANGE");
    }
    return this.repository.getTrialBalance(companyId, from, to);
  }

  listPostingRules(companyId: string, page: { cursor?: string; limit: number }) {
    return this.repository.listPostingRules(companyId, page);
  }

  getPostingRule(companyId: string, ruleId: string) {
    return this.repository.getPostingRule(companyId, ruleId);
  }

  createPostingRule(input: {
    companyId: string;
    actorUserId: string;
    code: string;
    name: string;
    sourceType: string;
    eventType: string;
    priority: number;
    conditions?: Record<string, unknown>;
    validFrom?: Date | null;
    validTo?: Date | null;
    lines: PostingRuleLineInput[];
  }) {
    assertPostingEvent(input.sourceType, input.eventType);
    assertPostingRuleLines(input.lines);
    if (input.validFrom && input.validTo && input.validFrom > input.validTo) {
      throw financeBadRequest("validFrom must be on or before validTo", "FINANCE_RULE_DATE_RANGE_INVALID");
    }
    return this.repository.createPostingRule(input);
  }

  createPostingRuleVersion(input: {
    companyId: string;
    actorUserId: string;
    ruleId: string;
    code: string;
    name: string;
    sourceType: string;
    eventType: string;
    priority: number;
    conditions?: Record<string, unknown>;
    validFrom?: Date | null;
    validTo?: Date | null;
    lines: PostingRuleLineInput[];
  }) {
    assertPostingEvent(input.sourceType, input.eventType);
    assertPostingRuleLines(input.lines);
    if (input.validFrom && input.validTo && input.validFrom > input.validTo) {
      throw financeBadRequest("validFrom must be on or before validTo", "FINANCE_RULE_DATE_RANGE_INVALID");
    }
    return this.repository.createPostingRuleVersion(input);
  }

  changePostingRuleStatus(input: {
    companyId: string;
    actorUserId: string;
    ruleId: string;
    status: "active" | "inactive";
  }) {
    return this.repository.changePostingRuleStatus(
      input.companyId,
      input.ruleId,
      input.actorUserId,
      input.status,
    );
  }

  ingestSourceEvent(input: CanonicalFinanceSourceEventInput) {
    const event = normalizeFinanceSourceEvent(input);
    return this.repository.ingestSourceEvent({
      event,
      payloadHash: financeSourceEventHash(event),
    });
  }

  processSourceEvent(sourceEventRecordId: string) {
    return this.repository.processSourceEvent(sourceEventRecordId);
  }

  listSourceEvents(input: {
    companyId: string;
    cursor?: string;
    limit: number;
    status?: "pending" | "processing" | "posted" | "exception";
  }) {
    return this.repository.listSourceEvents(
      input.companyId,
      { cursor: input.cursor, limit: input.limit },
      input.status,
    );
  }

  retrySourceEvent(input: {
    companyId: string;
    actorUserId: string;
    sourceEventRecordId: string;
  }) {
    return this.repository.retrySourceEvent(
      input.companyId,
      input.sourceEventRecordId,
      input.actorUserId,
    );
  }
}
