import type { FastifyPluginAsync } from "fastify";
import { ZodError } from "zod";
import { fastifyAuth } from "../../identity-access/transport/fastify-auth";
import { FinanceError } from "../domain/finance.errors";
import { FinanceService } from "../application/finance.service";
import { FinanceDocumentsService } from "../application/finance-documents.service";
import { prismaFinanceRepository } from "../infrastructure/prisma-finance.repository";
import { prismaFinanceDocumentsRepository } from "../infrastructure/prisma-finance-documents.repository";
import { financeReferenceAdapter } from "../infrastructure/finance-reference.adapter";
import { FinanceSubledgerService } from "../application/finance-subledger.service";
import { prismaFinanceSubledgerRepository } from "../infrastructure/prisma-finance-subledger.repository";
import { FinanceTreasuryService } from "../application/finance-treasury.service";
import { prismaFinanceTreasuryRepository } from "../infrastructure/prisma-finance-treasury.repository";
import { hasAnyPermissionSync } from "../../identity-access";
import {
  LOGISTICS_CHART_TEMPLATE_CODE,
  LOGISTICS_CHART_TEMPLATE_VERSION,
  LOGISTICS_STANDARD_CHART,
} from "../domain/chart-template";
import { FINANCE_AMOUNT_KEYS, FINANCE_POSTING_EVENTS } from "../domain/posting-rules";
import {
  bootstrapChartSchema,
  changePeriodStatusSchema,
  changePostingRuleStatusSchema,
  configureLegalEntitySchema,
  createAccountSchema,
  createJournalSchema,
  createPeriodSchema,
  createPostingRuleSchema,
  cursorPageSchema,
  financeIdParamSchema,
  reverseJournalSchema,
  sourceEventPageSchema,
  toDate,
  trialBalanceQuerySchema,
  createCarrierBillSchema,
  createProviderSettlementSchema,
  financeDocumentPageSchema,
  rejectFinanceDocumentSchema,
  reconcileSettlementLineSchema,
  receivablesAgingQuerySchema,
  payablesAgingQuerySchema,
  unappliedCashQuerySchema,
  bankAccountPageSchema,
  bankStatementPageSchema,
  changeBankAccountStatusSchema,
  createBankAccountSchema,
  createBankStatementSchema,
  createPaymentRunSchema,
  executePaymentRunSchema,
  financeReasonSchema,
  paymentRunPageSchema,
  reconcileBankStatementLineSchema,
} from "./validation";

const financeService = new FinanceService(prismaFinanceRepository);
const financeDocumentsService = new FinanceDocumentsService(
  prismaFinanceDocumentsRepository,
  financeReferenceAdapter,
);
const financeSubledgerService = new FinanceSubledgerService(prismaFinanceSubledgerRepository);
const financeTreasuryService = new FinanceTreasuryService(prismaFinanceTreasuryRepository);

function sendError(reply: any, error: unknown, fallback: string) {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: "Validation failed",
      code: "FINANCE_VALIDATION_FAILED",
      issues: error.flatten(),
    });
  }
  if (error instanceof FinanceError) {
    return reply.code(error.statusCode).send({ error: error.message, code: error.code });
  }
  const candidate = error as { code?: string; message?: string; statusCode?: number };
  if (candidate?.code === "P2002") {
    return reply.code(409).send({ error: "Finance record already exists", code: "FINANCE_DUPLICATE" });
  }
  const statusCode = candidate?.statusCode && candidate.statusCode >= 400 && candidate.statusCode <= 599
    ? candidate.statusCode
    : 500;
  return reply.code(statusCode).send({
    error: candidate?.message ?? fallback,
    code: statusCode === 500 ? "FINANCE_INTERNAL_ERROR" : "FINANCE_REFERENCE_ERROR",
  });
}

const financeFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/receivables/aging",
    { preHandler: fastifyAuth({ permission: "finance.receivables.read" }) },
    async (request, reply) => {
      try {
        const query = receivablesAgingQuerySchema.parse(request.query);
        return reply.send(await financeSubledgerService.getReceivablesAging({
          ...query,
          companyId: request.user!.companyId,
          asOf: toDate(query.asOf),
        }));
      } catch (error) {
        return sendError(reply, error, "Failed to load receivables aging");
      }
    },
  );

  fastify.get(
    "/receivables/unapplied-cash",
    { preHandler: fastifyAuth({ permission: "finance.receivables.read" }) },
    async (request, reply) => {
      try {
        const query = unappliedCashQuerySchema.parse(request.query);
        return reply.send(await financeSubledgerService.listUnappliedCash({
          ...query,
          companyId: request.user!.companyId,
        }));
      } catch (error) {
        return sendError(reply, error, "Failed to load unapplied cash");
      }
    },
  );

  fastify.get(
    "/payables/aging",
    { preHandler: fastifyAuth({ permission: "finance.payables.read" }) },
    async (request, reply) => {
      try {
        const query = payablesAgingQuerySchema.parse(request.query);
        return reply.send(await financeSubledgerService.getPayablesAging({
          ...query,
          companyId: request.user!.companyId,
          asOf: toDate(query.asOf),
        }));
      } catch (error) {
        return sendError(reply, error, "Failed to load payables aging");
      }
    },
  );

  fastify.get(
    "/bank-accounts",
    { preHandler: fastifyAuth({ permission: "finance.treasury.read" }) },
    async (request, reply) => {
      try {
        const page = bankAccountPageSchema.parse(request.query);
        return reply.send(await financeTreasuryService.listBankAccounts(request.user!.companyId, page));
      } catch (error) {
        return sendError(reply, error, "Failed to load bank accounts");
      }
    },
  );

  fastify.post(
    "/bank-accounts",
    { preHandler: fastifyAuth({ permission: "finance.treasury.manage" }) },
    async (request, reply) => {
      try {
        const input = createBankAccountSchema.parse(request.body);
        return reply.code(201).send(await financeTreasuryService.createBankAccount({
          ...input,
          companyId: request.user!.companyId,
          actorUserId: request.user!.id,
        }));
      } catch (error) {
        return sendError(reply, error, "Failed to create bank account");
      }
    },
  );

  fastify.patch(
    "/bank-accounts/:id/status",
    { preHandler: fastifyAuth({ permission: "finance.treasury.manage" }) },
    async (request, reply) => {
      try {
        const { id } = financeIdParamSchema.parse(request.params);
        const { isActive } = changeBankAccountStatusSchema.parse(request.body);
        return reply.send(await financeTreasuryService.changeBankAccountStatus(
          request.user!.companyId,
          id,
          request.user!.id,
          isActive,
        ));
      } catch (error) {
        return sendError(reply, error, "Failed to change bank-account status");
      }
    },
  );

  fastify.get(
    "/payment-runs",
    { preHandler: fastifyAuth({ permission: "finance.treasury.read" }) },
    async (request, reply) => {
      try {
        const page = paymentRunPageSchema.parse(request.query);
        return reply.send(await financeTreasuryService.listPaymentRuns(request.user!.companyId, page));
      } catch (error) {
        return sendError(reply, error, "Failed to load payment runs");
      }
    },
  );

  fastify.post(
    "/payment-runs",
    { preHandler: fastifyAuth({ permission: "finance.treasury.manage" }) },
    async (request, reply) => {
      try {
        const input = createPaymentRunSchema.parse(request.body);
        return reply.code(201).send(await financeTreasuryService.createPaymentRun({
          ...input,
          companyId: request.user!.companyId,
          actorUserId: request.user!.id,
          paymentDate: toDate(input.paymentDate),
          fxRateAsOf: input.fxRateAsOf ? new Date(input.fxRateAsOf) : null,
        }));
      } catch (error) {
        return sendError(reply, error, "Failed to create payment run");
      }
    },
  );

  fastify.get(
    "/payment-runs/:id",
    { preHandler: fastifyAuth({ permission: "finance.treasury.read" }) },
    async (request, reply) => {
      try {
        const { id } = financeIdParamSchema.parse(request.params);
        return reply.send(await financeTreasuryService.getPaymentRun(request.user!.companyId, id));
      } catch (error) {
        return sendError(reply, error, "Failed to load payment run");
      }
    },
  );

  fastify.post(
    "/payment-runs/:id/submit",
    { preHandler: fastifyAuth({ permission: "finance.treasury.manage" }) },
    async (request, reply) => {
      try {
        const { id } = financeIdParamSchema.parse(request.params);
        return reply.send(await financeTreasuryService.submitPaymentRun(
          request.user!.companyId,
          id,
          request.user!.id,
        ));
      } catch (error) {
        return sendError(reply, error, "Failed to submit payment run");
      }
    },
  );

  fastify.post(
    "/payment-runs/:id/approve",
    { preHandler: fastifyAuth({ permission: "finance.treasury.approve" }) },
    async (request, reply) => {
      try {
        const { id } = financeIdParamSchema.parse(request.params);
        return reply.send(await financeTreasuryService.approvePaymentRun({
          companyId: request.user!.companyId,
          paymentRunId: id,
          actorUserId: request.user!.id,
          allowSelfApproval: hasAnyPermissionSync(request.user!, ["policy.override"]),
        }));
      } catch (error) {
        return sendError(reply, error, "Failed to approve payment run");
      }
    },
  );

  fastify.post(
    "/payment-runs/:id/reject",
    { preHandler: fastifyAuth({ permission: "finance.treasury.approve" }) },
    async (request, reply) => {
      try {
        const { id } = financeIdParamSchema.parse(request.params);
        const { reason } = financeReasonSchema.parse(request.body);
        return reply.send(await financeTreasuryService.rejectPaymentRun(
          request.user!.companyId,
          id,
          request.user!.id,
          reason,
        ));
      } catch (error) {
        return sendError(reply, error, "Failed to reject payment run");
      }
    },
  );

  fastify.post(
    "/payment-runs/:id/execute",
    { preHandler: fastifyAuth({ permission: "finance.treasury.execute" }) },
    async (request, reply) => {
      try {
        const { id } = financeIdParamSchema.parse(request.params);
        const input = executePaymentRunSchema.parse(request.body);
        return reply.send(await financeTreasuryService.executePaymentRun({
          companyId: request.user!.companyId,
          paymentRunId: id,
          actorUserId: request.user!.id,
          allowControlOverride: hasAnyPermissionSync(request.user!, ["policy.override"]),
          bankReference: input.bankReference,
          executedAt: new Date(input.executedAt),
        }));
      } catch (error) {
        return sendError(reply, error, "Failed to execute payment run");
      }
    },
  );

  fastify.get(
    "/bank-statements",
    { preHandler: fastifyAuth({ permission: "finance.bankReconciliation.read" }) },
    async (request, reply) => {
      try {
        const page = bankStatementPageSchema.parse(request.query);
        return reply.send(await financeTreasuryService.listBankStatements(request.user!.companyId, page));
      } catch (error) {
        return sendError(reply, error, "Failed to load bank statements");
      }
    },
  );

  fastify.post(
    "/bank-statements",
    { preHandler: fastifyAuth({ permission: "finance.bankReconciliation.manage" }) },
    async (request, reply) => {
      try {
        const input = createBankStatementSchema.parse(request.body);
        return reply.code(201).send(await financeTreasuryService.createBankStatement({
          ...input,
          companyId: request.user!.companyId,
          actorUserId: request.user!.id,
          periodStart: toDate(input.periodStart),
          periodEnd: toDate(input.periodEnd),
          lines: input.lines.map((line) => ({
            ...line,
            bookingDate: toDate(line.bookingDate),
            valueDate: line.valueDate ? toDate(line.valueDate) : null,
          })),
        }));
      } catch (error) {
        return sendError(reply, error, "Failed to import bank statement");
      }
    },
  );

  fastify.get(
    "/bank-statements/:id",
    { preHandler: fastifyAuth({ permission: "finance.bankReconciliation.read" }) },
    async (request, reply) => {
      try {
        const { id } = financeIdParamSchema.parse(request.params);
        return reply.send(await financeTreasuryService.getBankStatement(request.user!.companyId, id));
      } catch (error) {
        return sendError(reply, error, "Failed to load bank statement");
      }
    },
  );

  fastify.post(
    "/bank-statements/:id/lines/:lineId/reconcile",
    { preHandler: fastifyAuth({ permission: "finance.bankReconciliation.manage" }) },
    async (request, reply) => {
      try {
        const params = request.params as { id?: string; lineId?: string };
        const { id } = financeIdParamSchema.parse({ id: params.id });
        const { id: lineId } = financeIdParamSchema.parse({ id: params.lineId });
        const input = reconcileBankStatementLineSchema.parse(request.body);
        return reply.send(await financeTreasuryService.reconcileBankStatementLine({
          companyId: request.user!.companyId,
          statementId: id,
          lineId,
          actorUserId: request.user!.id,
          ...input,
        }));
      } catch (error) {
        return sendError(reply, error, "Failed to reconcile bank-statement line");
      }
    },
  );

  fastify.post(
    "/bank-statements/:id/lines/:lineId/ignore",
    { preHandler: fastifyAuth({ permission: "finance.bankReconciliation.manage" }) },
    async (request, reply) => {
      try {
        const params = request.params as { id?: string; lineId?: string };
        const { id } = financeIdParamSchema.parse({ id: params.id });
        const { id: lineId } = financeIdParamSchema.parse({ id: params.lineId });
        const { reason } = financeReasonSchema.parse(request.body);
        return reply.send(await financeTreasuryService.ignoreBankStatementLine({
          companyId: request.user!.companyId,
          statementId: id,
          lineId,
          actorUserId: request.user!.id,
          reason,
        }));
      } catch (error) {
        return sendError(reply, error, "Failed to ignore bank-statement line");
      }
    },
  );

  fastify.post(
    "/bank-statements/:id/submit",
    { preHandler: fastifyAuth({ permission: "finance.bankReconciliation.manage" }) },
    async (request, reply) => {
      try {
        const { id } = financeIdParamSchema.parse(request.params);
        return reply.send(await financeTreasuryService.submitBankStatement(
          request.user!.companyId,
          id,
          request.user!.id,
        ));
      } catch (error) {
        return sendError(reply, error, "Failed to submit bank statement");
      }
    },
  );

  fastify.post(
    "/bank-statements/:id/approve",
    { preHandler: fastifyAuth({ permission: "finance.bankReconciliation.approve" }) },
    async (request, reply) => {
      try {
        const { id } = financeIdParamSchema.parse(request.params);
        return reply.send(await financeTreasuryService.approveBankStatement({
          companyId: request.user!.companyId,
          statementId: id,
          actorUserId: request.user!.id,
          allowSelfApproval: hasAnyPermissionSync(request.user!, ["policy.override"]),
        }));
      } catch (error) {
        return sendError(reply, error, "Failed to approve bank statement");
      }
    },
  );

  fastify.post(
    "/bank-statements/:id/reject",
    { preHandler: fastifyAuth({ permission: "finance.bankReconciliation.approve" }) },
    async (request, reply) => {
      try {
        const { id } = financeIdParamSchema.parse(request.params);
        const { reason } = financeReasonSchema.parse(request.body);
        return reply.send(await financeTreasuryService.rejectBankStatement(
          request.user!.companyId,
          id,
          request.user!.id,
          reason,
        ));
      } catch (error) {
        return sendError(reply, error, "Failed to reject bank statement");
      }
    },
  );

  fastify.get(
    "/provider-settlements",
    { preHandler: fastifyAuth({ permission: "finance.settlements.read" }) },
    async (request, reply) => {
      try {
        const page = financeDocumentPageSchema.parse(request.query);
        return reply.send(await financeDocumentsService.listProviderSettlements(
          request.user!.companyId,
          page,
        ));
      } catch (error) {
        return sendError(reply, error, "Failed to load provider settlements");
      }
    },
  );

  fastify.post(
    "/provider-settlements",
    { preHandler: fastifyAuth({ permission: "finance.settlements.manage" }) },
    async (request, reply) => {
      try {
        const input = createProviderSettlementSchema.parse(request.body);
        const settlement = await financeDocumentsService.createProviderSettlement({
          ...input,
          companyId: request.user!.companyId,
          actorUserId: request.user!.id,
          periodStart: toDate(input.periodStart),
          periodEnd: toDate(input.periodEnd),
          fxRateAsOf: input.fxRateAsOf ? new Date(input.fxRateAsOf) : null,
          lines: input.lines.map((line) => ({
            ...line,
            occurredAt: line.occurredAt ? new Date(line.occurredAt) : null,
          })),
        });
        return reply.code(201).send(settlement);
      } catch (error) {
        return sendError(reply, error, "Failed to create provider settlement");
      }
    },
  );

  fastify.get(
    "/provider-settlements/:id",
    { preHandler: fastifyAuth({ permission: "finance.settlements.read" }) },
    async (request, reply) => {
      try {
        const { id } = financeIdParamSchema.parse(request.params);
        return reply.send(await financeDocumentsService.getProviderSettlement(
          request.user!.companyId,
          id,
        ));
      } catch (error) {
        return sendError(reply, error, "Failed to load provider settlement");
      }
    },
  );

  fastify.post(
    "/provider-settlements/:id/submit",
    { preHandler: fastifyAuth({ permission: "finance.settlements.manage" }) },
    async (request, reply) => {
      try {
        const { id } = financeIdParamSchema.parse(request.params);
        return reply.send(await financeDocumentsService.submitProviderSettlement(
          request.user!.companyId,
          id,
          request.user!.id,
        ));
      } catch (error) {
        return sendError(reply, error, "Failed to submit provider settlement");
      }
    },
  );

  fastify.post(
    "/provider-settlements/:id/approve",
    { preHandler: fastifyAuth({ permission: "finance.settlements.approve" }) },
    async (request, reply) => {
      try {
        const { id } = financeIdParamSchema.parse(request.params);
        return reply.send(await financeDocumentsService.approveProviderSettlement({
          companyId: request.user!.companyId,
          settlementId: id,
          actorUserId: request.user!.id,
          allowSelfApproval: hasAnyPermissionSync(request.user!, ["policy.override"]),
        }));
      } catch (error) {
        return sendError(reply, error, "Failed to approve provider settlement");
      }
    },
  );

  fastify.post(
    "/provider-settlements/:id/lines/:lineId/reconcile",
    { preHandler: fastifyAuth({ permission: "finance.settlements.manage" }) },
    async (request, reply) => {
      try {
        const params = request.params as { id?: string; lineId?: string };
        const { id } = financeIdParamSchema.parse({ id: params.id });
        const { id: lineId } = financeIdParamSchema.parse({ id: params.lineId });
        const body = reconcileSettlementLineSchema.parse(request.body);
        return reply.send(await financeDocumentsService.reconcileProviderSettlementLine({
          companyId: request.user!.companyId,
          settlementId: id,
          lineId,
          actorUserId: request.user!.id,
          ...body,
        }));
      } catch (error) {
        return sendError(reply, error, "Failed to reconcile provider settlement line");
      }
    },
  );

  fastify.post(
    "/provider-settlements/:id/reject",
    { preHandler: fastifyAuth({ permission: "finance.settlements.approve" }) },
    async (request, reply) => {
      try {
        const { id } = financeIdParamSchema.parse(request.params);
        const { reason } = rejectFinanceDocumentSchema.parse(request.body);
        return reply.send(await financeDocumentsService.rejectProviderSettlement(
          request.user!.companyId,
          id,
          request.user!.id,
          reason,
        ));
      } catch (error) {
        return sendError(reply, error, "Failed to reject provider settlement");
      }
    },
  );

  fastify.get(
    "/carrier-bills",
    { preHandler: fastifyAuth({ permission: "finance.payables.read" }) },
    async (request, reply) => {
      try {
        const page = financeDocumentPageSchema.parse(request.query);
        return reply.send(await financeDocumentsService.listCarrierBills(
          request.user!.companyId,
          page,
        ));
      } catch (error) {
        return sendError(reply, error, "Failed to load carrier bills");
      }
    },
  );

  fastify.post(
    "/carrier-bills",
    { preHandler: fastifyAuth({ permission: "finance.payables.manage" }) },
    async (request, reply) => {
      try {
        const input = createCarrierBillSchema.parse(request.body);
        const bill = await financeDocumentsService.createCarrierBill({
          ...input,
          companyId: request.user!.companyId,
          actorUserId: request.user!.id,
          invoiceDate: toDate(input.invoiceDate),
          dueDate: input.dueDate ? toDate(input.dueDate) : null,
          fxRateAsOf: input.fxRateAsOf ? new Date(input.fxRateAsOf) : null,
        });
        return reply.code(201).send(bill);
      } catch (error) {
        return sendError(reply, error, "Failed to create carrier bill");
      }
    },
  );

  fastify.get(
    "/carrier-bills/:id",
    { preHandler: fastifyAuth({ permission: "finance.payables.read" }) },
    async (request, reply) => {
      try {
        const { id } = financeIdParamSchema.parse(request.params);
        return reply.send(await financeDocumentsService.getCarrierBill(request.user!.companyId, id));
      } catch (error) {
        return sendError(reply, error, "Failed to load carrier bill");
      }
    },
  );

  fastify.post(
    "/carrier-bills/:id/submit",
    { preHandler: fastifyAuth({ permission: "finance.payables.manage" }) },
    async (request, reply) => {
      try {
        const { id } = financeIdParamSchema.parse(request.params);
        return reply.send(await financeDocumentsService.submitCarrierBill(
          request.user!.companyId,
          id,
          request.user!.id,
        ));
      } catch (error) {
        return sendError(reply, error, "Failed to submit carrier bill");
      }
    },
  );

  fastify.post(
    "/carrier-bills/:id/approve",
    { preHandler: fastifyAuth({ permission: "finance.payables.approve" }) },
    async (request, reply) => {
      try {
        const { id } = financeIdParamSchema.parse(request.params);
        return reply.send(await financeDocumentsService.approveCarrierBill({
          companyId: request.user!.companyId,
          billId: id,
          actorUserId: request.user!.id,
          allowSelfApproval: hasAnyPermissionSync(request.user!, ["policy.override"]),
        }));
      } catch (error) {
        return sendError(reply, error, "Failed to approve carrier bill");
      }
    },
  );

  fastify.post(
    "/carrier-bills/:id/reject",
    { preHandler: fastifyAuth({ permission: "finance.payables.approve" }) },
    async (request, reply) => {
      try {
        const { id } = financeIdParamSchema.parse(request.params);
        const { reason } = rejectFinanceDocumentSchema.parse(request.body);
        return reply.send(await financeDocumentsService.rejectCarrierBill(
          request.user!.companyId,
          id,
          request.user!.id,
          reason,
        ));
      } catch (error) {
        return sendError(reply, error, "Failed to reject carrier bill");
      }
    },
  );

  fastify.get(
    "/legal-entity",
    { preHandler: fastifyAuth({ permission: "finance.settings.read" }) },
    async (request, reply) => {
      try {
        return reply.send(await financeService.getLegalEntity(request.user!.companyId));
      } catch (error) {
        return sendError(reply, error, "Failed to load finance legal entity");
      }
    },
  );

  fastify.put(
    "/legal-entity",
    { preHandler: fastifyAuth({ permission: "finance.settings.manage" }) },
    async (request, reply) => {
      try {
        const input = configureLegalEntitySchema.parse(request.body);
        return reply.send(
          await financeService.configureLegalEntity({
            ...input,
            companyId: request.user!.companyId,
            actorUserId: request.user!.id,
          }),
        );
      } catch (error) {
        return sendError(reply, error, "Failed to configure finance legal entity");
      }
    },
  );

  fastify.get(
    "/accounts",
    { preHandler: fastifyAuth({ permission: "finance.accounts.read" }) },
    async (request, reply) => {
      try {
        const page = cursorPageSchema.parse(request.query);
        return reply.send(await financeService.listAccounts(request.user!.companyId, page));
      } catch (error) {
        return sendError(reply, error, "Failed to load chart of accounts");
      }
    },
  );

  fastify.post(
    "/accounts/bootstrap",
    { preHandler: fastifyAuth({ permission: "finance.accounts.manage" }) },
    async (request, reply) => {
      try {
        const input = bootstrapChartSchema.parse(request.body);
        return reply.send(
          await financeService.bootstrapChart({
            ...input,
            companyId: request.user!.companyId,
            actorUserId: request.user!.id,
          }),
        );
      } catch (error) {
        return sendError(reply, error, "Failed to install chart template");
      }
    },
  );

  fastify.post(
    "/accounts",
    { preHandler: fastifyAuth({ permission: "finance.accounts.manage" }) },
    async (request, reply) => {
      try {
        const input = createAccountSchema.parse(request.body);
        const account = await financeService.createAccount({
          ...input,
          companyId: request.user!.companyId,
          actorUserId: request.user!.id,
        });
        return reply.code(201).send(account);
      } catch (error) {
        return sendError(reply, error, "Failed to create finance account");
      }
    },
  );

  fastify.get(
    "/setup/catalog",
    { preHandler: fastifyAuth({ permission: "finance.settings.read" }) },
    async (_request, reply) => reply.send({
      chartTemplates: [{
        code: LOGISTICS_CHART_TEMPLATE_CODE,
        version: LOGISTICS_CHART_TEMPLATE_VERSION,
        name: "CargoPilot logistics standard",
        accountCount: LOGISTICS_STANDARD_CHART.length,
      }],
      postingEvents: FINANCE_POSTING_EVENTS,
      amountKeys: FINANCE_AMOUNT_KEYS,
    }),
  );

  fastify.get(
    "/posting-rules",
    { preHandler: fastifyAuth({ permission: "finance.postingRules.read" }) },
    async (request, reply) => {
      try {
        const page = cursorPageSchema.parse(request.query);
        return reply.send(await financeService.listPostingRules(request.user!.companyId, page));
      } catch (error) {
        return sendError(reply, error, "Failed to load finance posting rules");
      }
    },
  );

  fastify.post(
    "/posting-rules",
    { preHandler: fastifyAuth({ permission: "finance.postingRules.manage" }) },
    async (request, reply) => {
      try {
        const input = createPostingRuleSchema.parse(request.body);
        const rule = await financeService.createPostingRule({
          ...input,
          validFrom: input.validFrom ? new Date(input.validFrom) : null,
          validTo: input.validTo ? new Date(input.validTo) : null,
          companyId: request.user!.companyId,
          actorUserId: request.user!.id,
        });
        return reply.code(201).send(rule);
      } catch (error) {
        return sendError(reply, error, "Failed to create finance posting rule");
      }
    },
  );

  fastify.get(
    "/posting-rules/:id",
    { preHandler: fastifyAuth({ permission: "finance.postingRules.read" }) },
    async (request, reply) => {
      try {
        const { id } = financeIdParamSchema.parse(request.params);
        return reply.send(await financeService.getPostingRule(request.user!.companyId, id));
      } catch (error) {
        return sendError(reply, error, "Failed to load finance posting rule");
      }
    },
  );

  fastify.post(
    "/posting-rules/:id/versions",
    { preHandler: fastifyAuth({ permission: "finance.postingRules.manage" }) },
    async (request, reply) => {
      try {
        const { id } = financeIdParamSchema.parse(request.params);
        const input = createPostingRuleSchema.parse(request.body);
        const rule = await financeService.createPostingRuleVersion({
          ...input,
          ruleId: id,
          validFrom: input.validFrom ? new Date(input.validFrom) : null,
          validTo: input.validTo ? new Date(input.validTo) : null,
          companyId: request.user!.companyId,
          actorUserId: request.user!.id,
        });
        return reply.code(201).send(rule);
      } catch (error) {
        return sendError(reply, error, "Failed to version finance posting rule");
      }
    },
  );

  fastify.patch(
    "/posting-rules/:id/status",
    { preHandler: fastifyAuth({ permission: "finance.postingRules.manage" }) },
    async (request, reply) => {
      try {
        const { id } = financeIdParamSchema.parse(request.params);
        const input = changePostingRuleStatusSchema.parse(request.body);
        return reply.send(await financeService.changePostingRuleStatus({
          ruleId: id,
          status: input.status,
          companyId: request.user!.companyId,
          actorUserId: request.user!.id,
        }));
      } catch (error) {
        return sendError(reply, error, "Failed to change finance posting rule status");
      }
    },
  );

  fastify.get(
    "/periods",
    { preHandler: fastifyAuth({ permission: "finance.periods.read" }) },
    async (request, reply) => {
      try {
        const page = cursorPageSchema.parse(request.query);
        return reply.send(await financeService.listPeriods(request.user!.companyId, page));
      } catch (error) {
        return sendError(reply, error, "Failed to load fiscal periods");
      }
    },
  );

  fastify.post(
    "/periods",
    { preHandler: fastifyAuth({ permission: "finance.periods.manage" }) },
    async (request, reply) => {
      try {
        const input = createPeriodSchema.parse(request.body);
        const period = await financeService.createPeriod({
          ...input,
          startDate: toDate(input.startDate),
          endDate: toDate(input.endDate),
          companyId: request.user!.companyId,
          actorUserId: request.user!.id,
        });
        return reply.code(201).send(period);
      } catch (error) {
        return sendError(reply, error, "Failed to create fiscal period");
      }
    },
  );

  fastify.patch(
    "/periods/:id/status",
    { preHandler: fastifyAuth({ permission: "finance.periods.close" }) },
    async (request, reply) => {
      try {
        const { id } = financeIdParamSchema.parse(request.params);
        const input = changePeriodStatusSchema.parse(request.body);
        return reply.send(
          await financeService.changePeriodStatus({
            periodId: id,
            status: input.status,
            companyId: request.user!.companyId,
            actorUserId: request.user!.id,
          }),
        );
      } catch (error) {
        return sendError(reply, error, "Failed to change fiscal period status");
      }
    },
  );

  fastify.get(
    "/journals",
    { preHandler: fastifyAuth({ permission: "finance.journals.read" }) },
    async (request, reply) => {
      try {
        const page = cursorPageSchema.parse(request.query);
        return reply.send(await financeService.listJournals(request.user!.companyId, page));
      } catch (error) {
        return sendError(reply, error, "Failed to load finance journals");
      }
    },
  );

  fastify.get(
    "/journals/:id",
    { preHandler: fastifyAuth({ permission: "finance.journals.read" }) },
    async (request, reply) => {
      try {
        const { id } = financeIdParamSchema.parse(request.params);
        return reply.send(await financeService.getJournal(request.user!.companyId, id));
      } catch (error) {
        return sendError(reply, error, "Failed to load finance journal");
      }
    },
  );

  fastify.post(
    "/journals",
    { preHandler: fastifyAuth({ permission: "finance.journals.create" }) },
    async (request, reply) => {
      try {
        const input = createJournalSchema.parse(request.body);
        const journal = await financeService.createDraftJournal({
          ...input,
          documentDate: toDate(input.documentDate),
          postingDate: toDate(input.postingDate),
          fxRateAsOf: input.fxRateAsOf ? new Date(input.fxRateAsOf) : null,
          companyId: request.user!.companyId,
          actorUserId: request.user!.id,
        });
        return reply.code(201).send(journal);
      } catch (error) {
        return sendError(reply, error, "Failed to create finance journal");
      }
    },
  );

  fastify.post(
    "/journals/:id/post",
    { preHandler: fastifyAuth({ permission: "finance.journals.post" }) },
    async (request, reply) => {
      try {
        const { id } = financeIdParamSchema.parse(request.params);
        return reply.send(
          await financeService.postJournal(request.user!.companyId, id, request.user!.id),
        );
      } catch (error) {
        return sendError(reply, error, "Failed to post finance journal");
      }
    },
  );

  fastify.post(
    "/journals/:id/reverse",
    { preHandler: fastifyAuth({ permission: "finance.journals.reverse" }) },
    async (request, reply) => {
      try {
        const { id } = financeIdParamSchema.parse(request.params);
        const input = reverseJournalSchema.parse(request.body);
        return reply.send(
          await financeService.reverseJournal({
            journalId: id,
            postingDate: toDate(input.postingDate),
            reason: input.reason,
            idempotencyKey: input.idempotencyKey,
            companyId: request.user!.companyId,
            actorUserId: request.user!.id,
          }),
        );
      } catch (error) {
        return sendError(reply, error, "Failed to reverse finance journal");
      }
    },
  );

  fastify.get(
    "/source-events",
    { preHandler: fastifyAuth({ permission: "finance.exceptions.read" }) },
    async (request, reply) => {
      try {
        const query = sourceEventPageSchema.parse(request.query);
        return reply.send(await financeService.listSourceEvents({
          companyId: request.user!.companyId,
          ...query,
        }));
      } catch (error) {
        return sendError(reply, error, "Failed to load finance source events");
      }
    },
  );

  fastify.get(
    "/exceptions",
    { preHandler: fastifyAuth({ permission: "finance.exceptions.read" }) },
    async (request, reply) => {
      try {
        const page = cursorPageSchema.parse(request.query);
        return reply.send(await financeService.listSourceEvents({
          companyId: request.user!.companyId,
          status: "exception",
          ...page,
        }));
      } catch (error) {
        return sendError(reply, error, "Failed to load finance exceptions");
      }
    },
  );

  fastify.post(
    "/source-events/:id/retry",
    { preHandler: fastifyAuth({ permission: "finance.exceptions.manage" }) },
    async (request, reply) => {
      try {
        const { id } = financeIdParamSchema.parse(request.params);
        return reply.send(await financeService.retrySourceEvent({
          companyId: request.user!.companyId,
          actorUserId: request.user!.id,
          sourceEventRecordId: id,
        }));
      } catch (error) {
        return sendError(reply, error, "Failed to retry finance source event");
      }
    },
  );

  fastify.get(
    "/reports/trial-balance",
    { preHandler: fastifyAuth({ permission: "finance.reports.read" }) },
    async (request, reply) => {
      try {
        const query = trialBalanceQuerySchema.parse(request.query);
        return reply.send(
          await financeService.getTrialBalance(
            request.user!.companyId,
            toDate(query.from),
            toDate(query.to),
          ),
        );
      } catch (error) {
        return sendError(reply, error, "Failed to build trial balance");
      }
    },
  );
};

export default financeFastifyRoutes;
