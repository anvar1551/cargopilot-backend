import { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type {
  FinanceSubledgerRepositoryPort,
  PayablesAgingQuery,
  ReceivablesAgingQuery,
  UnappliedCashQuery,
} from "../application/finance-subledger.port";
import { financeNotFound } from "../domain/finance.errors";

type AgingSummaryRow = {
  currency: string;
  current: Prisma.Decimal;
  days1To30: Prisma.Decimal;
  days31To60: Prisma.Decimal;
  days61To90: Prisma.Decimal;
  daysOver90: Prisma.Decimal;
  total: Prisma.Decimal;
};

type ReceivableRow = {
  id: string;
  sourceInvoiceId: string;
  invoiceNumber: string;
  orderId: string;
  customerEntityId: string | null;
  documentDate: Date;
  dueDate: Date;
  currency: string;
  originalAmount: Prisma.Decimal;
  outstandingAmount: Prisma.Decimal;
};

type PayableRow = {
  id: string;
  sourceCarrierBillId: string;
  billNumber: string;
  supplierInvoiceNumber: string;
  carrierProviderId: string;
  carrierCode: string;
  documentDate: Date;
  dueDate: Date;
  currency: string;
  originalAmount: Prisma.Decimal;
  outstandingAmount: Prisma.Decimal;
};

async function requireEntityId(companyId: string) {
  const entity = await prisma.financeLegalEntity.findUnique({
    where: { companyId },
    select: { id: true },
  });
  if (!entity) {
    throw financeNotFound("Finance legal entity is not configured", "FINANCE_ENTITY_NOT_CONFIGURED");
  }
  return entity.id;
}

function money(value: Prisma.Decimal | null | undefined) {
  return new Prisma.Decimal(value ?? 0).toFixed(4);
}

function summary(rows: AgingSummaryRow[]) {
  return rows.map((row) => ({
    currency: row.currency,
    current: money(row.current),
    days1To30: money(row.days1To30),
    days31To60: money(row.days31To60),
    days61To90: money(row.days61To90),
    daysOver90: money(row.daysOver90),
    total: money(row.total),
  }));
}

function serializedItem<T extends { originalAmount: Prisma.Decimal; outstandingAmount: Prisma.Decimal }>(row: T) {
  return {
    ...row,
    originalAmount: money(row.originalAmount),
    outstandingAmount: money(row.outstandingAmount),
    status: row.outstandingAmount.gte(row.originalAmount) ? "open" : "partial",
  };
}

function agingSums() {
  return Prisma.sql`
    COALESCE(SUM("outstandingAmount") FILTER (WHERE "dueDate" >= "asOf"), 0) AS "current",
    COALESCE(SUM("outstandingAmount") FILTER (WHERE "dueDate" < "asOf" AND "dueDate" >= "asOf" - 30), 0) AS "days1To30",
    COALESCE(SUM("outstandingAmount") FILTER (WHERE "dueDate" < "asOf" - 30 AND "dueDate" >= "asOf" - 60), 0) AS "days31To60",
    COALESCE(SUM("outstandingAmount") FILTER (WHERE "dueDate" < "asOf" - 60 AND "dueDate" >= "asOf" - 90), 0) AS "days61To90",
    COALESCE(SUM("outstandingAmount") FILTER (WHERE "dueDate" < "asOf" - 90), 0) AS "daysOver90",
    COALESCE(SUM("outstandingAmount"), 0) AS "total"
  `;
}

export const prismaFinanceSubledgerRepository: FinanceSubledgerRepositoryPort = {
  async getReceivablesAging(query: ReceivablesAgingQuery) {
    const legalEntityId = await requireEntityId(query.companyId);
    const currencyFilter = query.currency
      ? Prisma.sql`AND r."currency" = ${query.currency}`
      : Prisma.empty;
    const customerFilter = query.customerEntityId
      ? Prisma.sql`AND r."customerEntityId" = ${query.customerEntityId}::uuid`
      : Prisma.empty;
    let cursorFilter = Prisma.empty;
    if (query.cursor) {
      const cursor = await prisma.financeReceivableItem.findFirst({
        where: { id: query.cursor, legalEntityId },
        select: { id: true, dueDate: true },
      });
      if (!cursor) throw financeNotFound("Receivable cursor not found", "FINANCE_AGING_CURSOR_INVALID");
      cursorFilter = Prisma.sql`AND (r."dueDate", r."id") > (${cursor.dueDate}::date, ${cursor.id}::uuid)`;
    }
    const balanceCte = Prisma.sql`
      WITH balances AS (
        SELECT r."id", r."sourceInvoiceId", r."invoiceNumber", r."orderId",
          r."customerEntityId", r."documentDate", r."dueDate", r."currency",
          r."originalAmount", ${query.asOf}::date AS "asOf",
          GREATEST(
            r."originalAmount" - COALESCE(SUM(
              CASE WHEN a."type" = 'refund' THEN -a."amount" ELSE a."amount" END
            ) FILTER (WHERE a."occurredAt" < ${new Date(query.asOf.getTime() + 86_400_000)}), 0),
            0
          ) AS "outstandingAmount"
        FROM "FinanceReceivableItem" r
        LEFT JOIN "FinanceReceivableAllocation" a ON a."receivableId" = r."id"
        WHERE r."legalEntityId" = ${legalEntityId}::uuid
          AND r."documentDate" <= ${query.asOf}::date
          ${currencyFilter} ${customerFilter}
        GROUP BY r."id"
      )
    `;
    const [summaryRows, itemRows] = await Promise.all([
      prisma.$queryRaw<AgingSummaryRow[]>(Prisma.sql`
        ${balanceCte}
        SELECT "currency", ${agingSums()}
        FROM balances WHERE "outstandingAmount" > 0
        GROUP BY "currency" ORDER BY "currency"
      `),
      prisma.$queryRaw<ReceivableRow[]>(Prisma.sql`
        ${balanceCte}
        SELECT "id", "sourceInvoiceId", "invoiceNumber", "orderId", "customerEntityId",
          "documentDate", "dueDate", "currency", "originalAmount", "outstandingAmount"
        FROM balances r
        WHERE "outstandingAmount" > 0 ${cursorFilter}
        ORDER BY "dueDate" ASC, "id" ASC
        LIMIT ${query.limit + 1}
      `),
    ]);
    const hasMore = itemRows.length > query.limit;
    const page = hasMore ? itemRows.slice(0, query.limit) : itemRows;
    return {
      asOf: query.asOf,
      summary: summary(summaryRows),
      items: page.map(serializedItem),
      nextCursor: hasMore && page.length > 0 ? page[page.length - 1].id : null,
    };
  },

  async getPayablesAging(query: PayablesAgingQuery) {
    const legalEntityId = await requireEntityId(query.companyId);
    const currencyFilter = query.currency
      ? Prisma.sql`AND p."currency" = ${query.currency}`
      : Prisma.empty;
    const carrierFilter = query.carrierProviderId
      ? Prisma.sql`AND p."carrierProviderId" = ${query.carrierProviderId}::uuid`
      : Prisma.empty;
    let cursorFilter = Prisma.empty;
    if (query.cursor) {
      const cursor = await prisma.financePayableItem.findFirst({
        where: { id: query.cursor, legalEntityId },
        select: { id: true, dueDate: true },
      });
      if (!cursor) throw financeNotFound("Payable cursor not found", "FINANCE_AGING_CURSOR_INVALID");
      cursorFilter = Prisma.sql`AND (p."dueDate", p."id") > (${cursor.dueDate}::date, ${cursor.id}::uuid)`;
    }
    const balanceCte = Prisma.sql`
      WITH balances AS (
        SELECT p."id", p."sourceCarrierBillId", p."billNumber", p."supplierInvoiceNumber",
          p."carrierProviderId", p."carrierCode", p."documentDate", p."dueDate", p."currency",
          p."originalAmount", ${query.asOf}::date AS "asOf",
          GREATEST(
            p."originalAmount" - COALESCE(SUM(a."amount") FILTER (
              WHERE a."occurredAt" < ${new Date(query.asOf.getTime() + 86_400_000)}
            ), 0),
            0
          ) AS "outstandingAmount"
        FROM "FinancePayableItem" p
        LEFT JOIN "FinancePayableAllocation" a ON a."payableItemId" = p."id"
        WHERE p."legalEntityId" = ${legalEntityId}::uuid
          AND p."documentDate" <= ${query.asOf}::date
          ${currencyFilter} ${carrierFilter}
        GROUP BY p."id"
      )
    `;
    const [summaryRows, itemRows] = await Promise.all([
      prisma.$queryRaw<AgingSummaryRow[]>(Prisma.sql`
        ${balanceCte}
        SELECT "currency", ${agingSums()}
        FROM balances WHERE "outstandingAmount" > 0
        GROUP BY "currency" ORDER BY "currency"
      `),
      prisma.$queryRaw<PayableRow[]>(Prisma.sql`
        ${balanceCte}
        SELECT "id", "sourceCarrierBillId", "billNumber", "supplierInvoiceNumber",
          "carrierProviderId", "carrierCode", "documentDate", "dueDate",
          "currency", "originalAmount", "outstandingAmount"
        FROM balances p
        WHERE "outstandingAmount" > 0 ${cursorFilter}
        ORDER BY "dueDate" ASC, "id" ASC
        LIMIT ${query.limit + 1}
      `),
    ]);
    const hasMore = itemRows.length > query.limit;
    const page = hasMore ? itemRows.slice(0, query.limit) : itemRows;
    return {
      asOf: query.asOf,
      summary: summary(summaryRows),
      items: page.map(serializedItem),
      nextCursor: hasMore && page.length > 0 ? page[page.length - 1].id : null,
    };
  },

  async listUnappliedCash(query: UnappliedCashQuery) {
    const legalEntityId = await requireEntityId(query.companyId);
    if (query.cursor) {
      const cursorExists = await prisma.financeUnappliedCash.count({
        where: { id: query.cursor, legalEntityId },
      });
      if (!cursorExists) {
        throw financeNotFound("Unapplied cash cursor not found", "FINANCE_AGING_CURSOR_INVALID");
      }
    }
    const where = {
      legalEntityId,
      ...(query.currency ? { currency: query.currency } : {}),
      ...(query.customerEntityId ? { customerEntityId: query.customerEntityId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
    } satisfies Prisma.FinanceUnappliedCashWhereInput;
    const [rows, grouped] = await Promise.all([
      prisma.financeUnappliedCash.findMany({
        where,
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        include: {
          applications: {
            orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          },
        },
      }),
      prisma.financeUnappliedCash.groupBy({
        by: ["currency", "type"],
        where,
        _sum: { remainingAmount: true },
        _count: { _all: true },
        orderBy: [{ currency: "asc" }, { type: "asc" }],
      }),
    ]);
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      summary: grouped.map((row) => ({
        currency: row.currency,
        type: row.type,
        remainingAmount: money(row._sum.remainingAmount),
        count: row._count._all,
      })),
      items: page.map((row) => ({
        ...row,
        originalAmount: money(row.originalAmount),
        remainingAmount: money(row.remainingAmount),
        applications: row.applications.map((application) => ({
          ...application,
          amount: money(application.amount),
        })),
      })),
      nextCursor: hasMore && page.length > 0 ? page[page.length - 1].id : null,
    };
  },
};
