import type { AppUser } from "../../../types/app-user";
import { subledgerOwner, receivablePredicate, payablePredicate, receivableAllocationPredicate, payableAllocationPredicate, cashPredicate, paymentSourcePredicate } from "./subledger-read-ownership";
import { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type {
  FinanceSubledgerRepositoryPort,
  PayablesAgingQuery,
  ReceivablesAgingQuery,
  UnappliedCashQuery,
} from "../application/finance-subledger.port";
import { financeConflict, financeNotFound } from "../domain/finance.errors";

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
  async getReceivablesAging(actor: AppUser, query: ReceivablesAgingQuery) {
    const owner=await subledgerOwner(actor,query,"receivable");
    return prisma.$transaction(async tx=>{
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const ownership=receivablePredicate(owner);
    const currencyFilter = query.currency
      ? Prisma.sql`AND r."currency" = ${query.currency}`
      : Prisma.empty;
    const customerFilter = query.customerEntityId
      ? Prisma.sql`AND r."customerEntityId" = ${query.customerEntityId}::uuid`
      : Prisma.empty;
    let cursorFilter = Prisma.empty;
    const invalid=await tx.$queryRaw<{id:string}[]>(Prisma.sql`SELECT r.id FROM "FinanceReceivableItem" r WHERE ${ownership} AND r."documentDate" <= ${query.asOf}::date ${currencyFilter} ${customerFilter} AND EXISTS(SELECT 1 FROM "FinanceReceivableAllocation" a WHERE a."receivableId"=r.id AND a."occurredAt" < ${new Date(query.asOf.getTime()+86_400_000)} AND NOT (${receivableAllocationPredicate(owner)})) LIMIT 1`);
    if(invalid.length)throw financeConflict("Subledger allocation ownership is inconsistent","FINANCE_SUBLEDGER_REFERENCE_CONFLICT");
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
        WHERE ${ownership}
          AND r."documentDate" <= ${query.asOf}::date
          ${currencyFilter} ${customerFilter}
        GROUP BY r."id"
      )
    `;
    if(query.cursor){const rows=await tx.$queryRaw<{id:string;dueDate:Date}[]>(Prisma.sql`${balanceCte} SELECT id,"dueDate" FROM balances WHERE id=${query.cursor}::uuid AND "outstandingAmount">0`);const cursor=rows[0];if(!cursor)throw financeNotFound("Subledger cursor not found","FINANCE_AGING_CURSOR_INVALID");cursorFilter=Prisma.sql`AND (r."dueDate",r.id)>(${cursor.dueDate}::date,${cursor.id}::uuid)`;}
    const [summaryRows, itemRows] = await Promise.all([
      tx.$queryRaw<AgingSummaryRow[]>(Prisma.sql`
        ${balanceCte}
        SELECT "currency", ${agingSums()}
        FROM balances WHERE "outstandingAmount" > 0
        GROUP BY "currency" ORDER BY "currency"
      `),
      tx.$queryRaw<ReceivableRow[]>(Prisma.sql`
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
    },{isolationLevel:"RepeatableRead",maxWait:2000,timeout:10000});
  },

  async getPayablesAging(actor: AppUser, query: PayablesAgingQuery) {
    const owner=await subledgerOwner(actor,query,"payable");
    return prisma.$transaction(async tx=>{
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const ownership=payablePredicate(owner);
    const currencyFilter = query.currency
      ? Prisma.sql`AND p."currency" = ${query.currency}`
      : Prisma.empty;
    const carrierFilter = query.carrierProviderId
      ? Prisma.sql`AND p."carrierProviderId" = ${query.carrierProviderId}::uuid`
      : Prisma.empty;
    let cursorFilter = Prisma.empty;
    const invalid=await tx.$queryRaw<{id:string}[]>(Prisma.sql`SELECT p.id FROM "FinancePayableItem" p WHERE ${ownership} AND p."documentDate" <= ${query.asOf}::date ${currencyFilter} ${carrierFilter} AND EXISTS(SELECT 1 FROM "FinancePayableAllocation" a WHERE a."payableItemId"=p.id AND a."occurredAt" < ${new Date(query.asOf.getTime()+86_400_000)} AND NOT (${payableAllocationPredicate(owner)})) LIMIT 1`);
    if(invalid.length)throw financeConflict("Subledger allocation ownership is inconsistent","FINANCE_SUBLEDGER_REFERENCE_CONFLICT");
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
        WHERE ${ownership}
          AND p."documentDate" <= ${query.asOf}::date
          ${currencyFilter} ${carrierFilter}
        GROUP BY p."id"
      )
    `;
    if(query.cursor){const rows=await tx.$queryRaw<{id:string;dueDate:Date}[]>(Prisma.sql`${balanceCte} SELECT id,"dueDate" FROM balances WHERE id=${query.cursor}::uuid AND "outstandingAmount">0`);const cursor=rows[0];if(!cursor)throw financeNotFound("Subledger cursor not found","FINANCE_AGING_CURSOR_INVALID");cursorFilter=Prisma.sql`AND (p."dueDate",p.id)>(${cursor.dueDate}::date,${cursor.id}::uuid)`;}
    const [summaryRows, itemRows] = await Promise.all([
      tx.$queryRaw<AgingSummaryRow[]>(Prisma.sql`
        ${balanceCte}
        SELECT "currency", ${agingSums()}
        FROM balances WHERE "outstandingAmount" > 0
        GROUP BY "currency" ORDER BY "currency"
      `),
      tx.$queryRaw<PayableRow[]>(Prisma.sql`
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
    },{isolationLevel:"RepeatableRead",maxWait:2000,timeout:10000});
  },

  async listUnappliedCash(actor:AppUser,query:UnappliedCashQuery){
    const owner=await subledgerOwner(actor,query,"cash");
    return prisma.$transaction(async tx=>{
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const currency=query.currency?Prisma.sql`AND u.currency=${query.currency}`:Prisma.empty;
      const customer=query.customerEntityId?Prisma.sql`AND u."customerEntityId"=${query.customerEntityId}::uuid`:Prisma.empty;
      const type=query.type?Prisma.sql`AND u.type=${query.type}::"FinanceUnappliedCashType"`:Prisma.empty;
      const status=query.status?Prisma.sql`AND u.status=${query.status}::"FinanceUnappliedCashStatus"`:Prisma.empty;
      const owned=Prisma.sql`${cashPredicate(owner)} ${currency} ${customer} ${type} ${status}`;
      const invalid=await tx.$queryRaw<{id:string}[]>(Prisma.sql`SELECT u.id FROM "FinanceUnappliedCash" u WHERE ${owned} AND EXISTS(SELECT 1 FROM "FinanceUnappliedCashApplication" a WHERE a."unappliedCashId"=u.id AND (a.currency<>u.currency OR a.amount<0 OR NOT (${paymentSourcePredicate(owner,"u",true)}) OR NOT EXISTS(SELECT 1 FROM "FinanceSourceEvent" s WHERE s."sourceEventId"=a."sourceEventId" AND s."companyId"=${owner.companyId}::uuid AND s."legalEntityId"=u."legalEntityId") OR a."receivableId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "FinanceReceivableItem" r WHERE r.id=a."receivableId" AND r."legalEntityId"=u."legalEntityId" AND r."orderId"=u."orderId" AND r.currency=u.currency AND ${receivablePredicate(owner)}))) LIMIT 1`);
      if(invalid.length)throw financeConflict("Cash application ownership is inconsistent","FINANCE_SUBLEDGER_REFERENCE_CONFLICT");
      let keyset=Prisma.empty;
      if(query.cursor){const cursors=await tx.$queryRaw<{id:string;occurredAt:Date}[]>(Prisma.sql`SELECT u.id,u."occurredAt" FROM "FinanceUnappliedCash" u WHERE ${owned} AND u.id=${query.cursor}::uuid`);const cursor=cursors[0];if(!cursor)throw financeNotFound("Unapplied cash cursor not found","FINANCE_AGING_CURSOR_INVALID");keyset=Prisma.sql`AND (u."occurredAt",u.id)<(${cursor.occurredAt},${cursor.id}::uuid)`;}
      const rows=await tx.$queryRaw<any[]>(Prisma.sql`SELECT u.id,u.type,u."orderId",u."customerEntityId",u.currency,u."originalAmount",u."remainingAmount",u.status,u."occurredAt",u."createdAt",u."updatedAt" FROM "FinanceUnappliedCash" u WHERE ${owned} ${keyset} ORDER BY u."occurredAt" DESC,u.id DESC LIMIT ${query.limit+1}`);
      const grouped=await tx.$queryRaw<{currency:string;type:string;remainingAmount:Prisma.Decimal;count:number}[]>(Prisma.sql`SELECT u.currency,u.type,SUM(u."remainingAmount") AS "remainingAmount",COUNT(*)::int AS count FROM "FinanceUnappliedCash" u WHERE ${owned} GROUP BY u.currency,u.type ORDER BY u.currency,u.type`);
      const hasMore=rows.length>query.limit,page=rows.slice(0,query.limit);
      const applications=await tx.financeUnappliedCashApplication.findMany({where:{unappliedCashId:{in:page.map(r=>r.id)}},orderBy:[{occurredAt:"desc"},{id:"desc"}],take:1001,select:{id:true,unappliedCashId:true,type:true,amount:true,currency:true,occurredAt:true,createdAt:true}});if(applications.length>1000)throw financeConflict("Cash application detail exceeds supported size","FINANCE_SUBLEDGER_DETAIL_LIMIT");
      const items=page.map(row=>({...row,originalAmount:money(row.originalAmount),remainingAmount:money(row.remainingAmount),applications:applications.filter(a=>a.unappliedCashId===row.id).map(a=>({id:a.id,type:a.type,amount:money(a.amount),currency:a.currency,occurredAt:a.occurredAt,createdAt:a.createdAt}))}));
      return {summary:grouped.map(r=>({...r,remainingAmount:money(r.remainingAmount)})),items,nextCursor:hasMore&&page.length?page[page.length-1].id:null};
    },{isolationLevel:"RepeatableRead",maxWait:2000,timeout:10000});
  },
};
