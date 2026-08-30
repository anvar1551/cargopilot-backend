import type { JournalLineInput } from "../domain/ledger";
import type { ChartTemplateAccount } from "../domain/chart-template";
import type { PostingRuleLineInput } from "../domain/posting-rules";
import type { CanonicalFinanceSourceEvent } from "../domain/source-event";

export type CursorPage = { cursor?: string; limit: number };

export type ConfigureLegalEntityCommand = {
  companyId: string;
  actorUserId: string;
  baseCurrency: string;
  reportingCurrency?: string | null;
  fiscalYearStartMonth: number;
  timezone: string;
};

export type CreateAccountCommand = {
  companyId: string;
  actorUserId: string;
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
  parentId?: string | null;
  allowPosting: boolean;
  isControlAccount: boolean;
  currency?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown>;
};

export type CreatePeriodCommand = {
  companyId: string;
  actorUserId: string;
  fiscalYear: number;
  periodNumber: number;
  name: string;
  startDate: Date;
  endDate: Date;
};

export type ChangePeriodStatusCommand = {
  companyId: string;
  actorUserId: string;
  periodId: string;
  status: "open" | "restricted" | "closed";
};

export type CreateJournalCommand = {
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
};

export type ReverseJournalCommand = {
  companyId: string;
  actorUserId: string;
  journalId: string;
  postingDate: Date;
  reason: string;
  idempotencyKey: string;
};

export type BootstrapChartCommand = {
  companyId: string;
  actorUserId: string;
  templateCode: string;
  templateVersion: number;
  accounts: readonly ChartTemplateAccount[];
};

export type CreatePostingRuleCommand = {
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
};

export type CreatePostingRuleVersionCommand = CreatePostingRuleCommand & {
  ruleId: string;
};

export type IngestFinanceSourceEventCommand = {
  event: CanonicalFinanceSourceEvent;
  payloadHash: string;
};

export interface FinanceRepositoryPort {
  getLegalEntity(companyId: string): Promise<unknown>;
  configureLegalEntity(command: ConfigureLegalEntityCommand): Promise<unknown>;
  listAccounts(companyId: string, page: CursorPage): Promise<unknown>;
  createAccount(command: CreateAccountCommand): Promise<unknown>;
  bootstrapChart(command: BootstrapChartCommand): Promise<unknown>;
  listPeriods(companyId: string, page: CursorPage): Promise<unknown>;
  createPeriod(command: CreatePeriodCommand): Promise<unknown>;
  changePeriodStatus(command: ChangePeriodStatusCommand): Promise<unknown>;
  listJournals(companyId: string, page: CursorPage): Promise<unknown>;
  getJournal(companyId: string, journalId: string): Promise<unknown>;
  createDraftJournal(command: CreateJournalCommand): Promise<unknown>;
  postJournal(companyId: string, journalId: string, actorUserId: string): Promise<unknown>;
  reverseJournal(command: ReverseJournalCommand): Promise<unknown>;
  getTrialBalance(companyId: string, from: Date, to: Date): Promise<unknown>;
  listPostingRules(companyId: string, page: CursorPage): Promise<unknown>;
  getPostingRule(companyId: string, ruleId: string): Promise<unknown>;
  createPostingRule(command: CreatePostingRuleCommand): Promise<unknown>;
  createPostingRuleVersion(command: CreatePostingRuleVersionCommand): Promise<unknown>;
  changePostingRuleStatus(
    companyId: string,
    ruleId: string,
    actorUserId: string,
    status: "active" | "inactive",
  ): Promise<unknown>;
  ingestSourceEvent(command: IngestFinanceSourceEventCommand): Promise<unknown>;
  processSourceEvent(sourceEventRecordId: string): Promise<unknown>;
  listSourceEvents(
    companyId: string,
    page: CursorPage,
    status?: "pending" | "processing" | "posted" | "exception",
  ): Promise<unknown>;
  retrySourceEvent(companyId: string, sourceEventRecordId: string, actorUserId: string): Promise<unknown>;
}
