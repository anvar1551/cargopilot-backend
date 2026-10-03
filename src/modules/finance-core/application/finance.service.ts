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
import type { AppUser } from "../../../types/app-user";
import { rejectUnapprovedAutomaticPosting } from "../domain/automatic-execution-containment";
import { FinanceError } from "../domain/finance.errors";
import { requirePostingRuleMutation, requireAccountMutation, requireLegalEntityContext, rejectUnapprovedLegalEntityConfiguration, rejectUnapprovedPeriodConfiguration, rejectUnapprovedManualJournalExecution } from "./legal-entity-access";

export class FinanceService {
  constructor(private readonly repository: FinanceRepositoryPort) {}

  async getLegalEntity(actor: AppUser) {
    await requireLegalEntityContext(actor, "finance.settings.read");
    return this.repository.getLegalEntity(actor);
  }

  async configureLegalEntity(input: {
    companyId: string;
    actorUserId: string;
    baseCurrency: string;
    reportingCurrency?: string | null;
    fiscalYearStartMonth: number;
    timezone: string;
  }, actor: AppUser) {
    await requireLegalEntityContext(actor, "finance.settings.manage");
    rejectUnapprovedLegalEntityConfiguration();
    const baseCurrency = assertFinanceCurrency(input.baseCurrency);
    const reportingCurrency = input.reportingCurrency
      ? assertFinanceCurrency(input.reportingCurrency!)
      : null;
    return this.repository.configureLegalEntity({
      ...input,
      baseCurrency,
      reportingCurrency,
    });
  }

  async listAccounts(actor: AppUser, page: { cursor?: string; limit: number }) {
    await requireLegalEntityContext(actor, "finance.accounts.read");
    return this.repository.listAccounts(actor, page);
  }

  async createAccount(input: CreateAccountCommand, actor: AppUser) {
    await requireAccountMutation(actor, input);
    const currency = input.currency ? assertFinanceCurrency(input.currency) : null;
    return this.repository.createAccount({ ...input, currency }, actor);
  }

  async bootstrapChart(input: {
    companyId: string;
    actorUserId: string;
    templateCode: string;
    templateVersion: number;
  }, actor: AppUser) {
    await requireAccountMutation(actor, input);
    const accounts = getChartTemplate(input.templateCode, input.templateVersion);
    if (!accounts) {
      throw financeBadRequest(
        `Unknown chart template ${input.templateCode} v${input.templateVersion}`,
        "FINANCE_CHART_TEMPLATE_UNKNOWN",
      );
    }
    return this.repository.bootstrapChart({ ...input, accounts }, actor);
  }

  async listPeriods(actor: AppUser, page: { cursor?: string; limit: number }) {
    await requireLegalEntityContext(actor, "finance.periods.read");
    return this.repository.listPeriods(actor, page);
  }

  async createPeriod(input: {
    companyId: string;
    actorUserId: string;
    fiscalYear: number;
    periodNumber: number;
    name: string;
    startDate: Date;
    endDate: Date;
  }, actor: AppUser) {
    await requireLegalEntityContext(actor, "finance.periods.manage");
    if (input.startDate > input.endDate) {
      throw financeBadRequest(
        "Fiscal period startDate must be on or before endDate",
        "FINANCE_INVALID_PERIOD_RANGE",
      );
    }
    rejectUnapprovedPeriodConfiguration();
    return this.repository.createPeriod(input);
  }

  async changePeriodStatus(input: {
    companyId: string;
    actorUserId: string;
    periodId: string;
    status: "open" | "restricted" | "closed";
  }, actor: AppUser) {
    await requireLegalEntityContext(actor, "finance.periods.close");
    rejectUnapprovedPeriodConfiguration();
    return this.repository.changePeriodStatus(input);
  }

  async listJournals(actor: AppUser, page: { cursor?: string; limit: number }) {
    await requireLegalEntityContext(actor, "finance.journals.read");
    return this.repository.listJournals(actor, page);
  }

  async getJournal(actor: AppUser, journalId: string) {
    await requireLegalEntityContext(actor, "finance.journals.read");
    return this.repository.getJournal(actor, journalId);
  }

  async createDraftJournal(input: {
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
  }, actor: AppUser) {
    await requireLegalEntityContext(actor, "finance.journals.create");
    const currency = assertFinanceCurrency(input.currency);
    return this.repository.createDraftJournal({ ...input, currency }, actor);
  }

  async postJournal(actor: AppUser, journalId: string) {
    await requireLegalEntityContext(actor, "finance.journals.post");
    rejectUnapprovedManualJournalExecution();
    return this.repository.postJournal(actor, journalId);
  }

  async reverseJournal(input: {
    companyId: string;
    actorUserId: string;
    journalId: string;
    postingDate: Date;
    reason: string;
    idempotencyKey: string;
  }, actor: AppUser) {
    await requireLegalEntityContext(actor, "finance.journals.reverse");
    rejectUnapprovedManualJournalExecution();
    return this.repository.reverseJournal(input, actor);
  }

  async getTrialBalance(actor: AppUser, from: Date, to: Date) {
    if (!(from instanceof Date) || !(to instanceof Date) || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) {
      throw financeBadRequest("from must be on or before to", "FINANCE_INVALID_DATE_RANGE");
    }
    await requireLegalEntityContext(actor, "finance.reports.read");
    return this.repository.getTrialBalance(actor, from, to);
  }

  async listPostingRules(actor: AppUser, page: { cursor?: string; limit: number }) {
    await requireLegalEntityContext(actor, "finance.postingRules.read");
    return this.repository.listPostingRules(actor, page);
  }

  async getPostingRule(actor: AppUser, ruleId: string) {
    await requireLegalEntityContext(actor, "finance.postingRules.read");
    return this.repository.getPostingRule(actor, ruleId);
  }

  async createPostingRule(input: {
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
  }, actor: AppUser) {
    await requirePostingRuleMutation(actor, input);
    assertPostingEvent(input.sourceType, input.eventType);
    assertPostingRuleLines(input.lines);
    if (input.validFrom && input.validTo && input.validFrom > input.validTo) {
      throw financeBadRequest("validFrom must be on or before validTo", "FINANCE_RULE_DATE_RANGE_INVALID");
    }
    return this.repository.createPostingRule(input, actor);
  }

  async createPostingRuleVersion(input: {
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
  }, actor: AppUser) {
    await requirePostingRuleMutation(actor, input);
    assertPostingEvent(input.sourceType, input.eventType);
    assertPostingRuleLines(input.lines);
    if (input.validFrom && input.validTo && input.validFrom > input.validTo) {
      throw financeBadRequest("validFrom must be on or before validTo", "FINANCE_RULE_DATE_RANGE_INVALID");
    }
    return this.repository.createPostingRuleVersion(input, actor);
  }

  async changePostingRuleStatus(input: {
    companyId: string;
    actorUserId: string;
    ruleId: string;
    status: "active" | "inactive";
  }, actor: AppUser) {
    await requirePostingRuleMutation(actor, input);
    return this.repository.changePostingRuleStatus(
      input.companyId,
      input.ruleId,
      input.actorUserId,
      input.status,
      actor,
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

  async listSourceEvents(actor: AppUser, input: { cursor?: string; limit: number; status?: "pending" | "processing" | "posted" | "exception" }) {
    await requireLegalEntityContext(actor, "finance.exceptions.read");
    if (!input || Object.keys(input).some(key => !["cursor", "limit", "status"].includes(key))) throw financeBadRequest("Invalid source event page", "FINANCE_INVALID_PAGE");
    return this.repository.listSourceEvents(actor, { cursor: input.cursor, limit: input.limit }, input.status);
  }

  async retrySourceEvent(input: {
    companyId: string;
    actorUserId: string;
    sourceEventRecordId: string;
  }, actor: AppUser) {
    const context = await requireLegalEntityContext(actor, "finance.exceptions.manage");
    if (context.companyId !== input.companyId || context.userId !== input.actorUserId) throw new FinanceError("Finance retry context mismatch", 403, "FINANCE_SOURCE_CONTEXT_REJECTED");
    rejectUnapprovedAutomaticPosting();
    return this.repository.retrySourceEvent(
      input.companyId,
      input.sourceEventRecordId,
      input.actorUserId,
      actor,
    );
  }
}
