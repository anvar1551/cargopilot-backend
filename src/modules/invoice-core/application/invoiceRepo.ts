import { authorizedInvoiceWhere } from "./invoiceAccess";
import { InvoiceStatus, Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";

function invoiceError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode });
}

function publicInvoice(invoice: any) {
  return {
    id: invoice.id, companyId: invoice.companyId, orderId: invoice.orderId,
    customerId: invoice.customerId, customerEntityId: invoice.customerEntityId,
    invoiceNumber: invoice.invoiceNumber, amount: invoice.amount.toFixed(4), currency: invoice.currency,
    fxRate: invoice.fxRate.toFixed(10), fxRateAsOf: invoice.fxRateAsOf,
    status: invoice.status, paymentUrl: invoice.paymentUrl, issuedByUserId: invoice.issuedByUserId,
    issuedAt: invoice.issuedAt, dueAt: invoice.dueAt, createdAt: invoice.createdAt, updatedAt: invoice.updatedAt,
    ...(invoice.order ? { order: { orderNumber: invoice.order.orderNumber } } : {}),
    ...(invoice.customerEntity !== undefined ? { customerEntity: invoice.customerEntity ? {
      id: invoice.customerEntity.id, name: invoice.customerEntity.name, companyName: invoice.customerEntity.companyName,
    } : null } : {}),
  };
}

export async function issueOrderInvoiceForActor(args: {
  user: AppUser;
  orderId: string;
  dueAt?: Date | null;
}) {

  if (Object.keys(args).some(key => !["user", "orderId", "dueAt"].includes(key)) ||
      (args.dueAt != null && (!(args.dueAt instanceof Date) || !Number.isFinite(args.dueAt.getTime())))) {
    throw invoiceError("Unsupported invoice input", 400);
  }
  const owned = await authorizedInvoiceWhere(args.user, "finance.invoices.issue");
  const invoice = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Order" WHERE id = ${args.orderId}::uuid
      AND "tenantId" = ${args.user.tenantId}::uuid
      AND "ownerOrgId" = ${args.user.companyId}::uuid FOR UPDATE`;
    if (locked.length !== 1) throw invoiceError("Order not found", 404);
    const order = await tx.order.findFirst({
      where: { AND: [{ id: args.orderId }, owned.order!.is!] },
      select: { id: true, tenantId: true, ownerOrgId: true, customerId: true, customerEntityId: true },
    });
    if (!order || order.tenantId !== args.user.tenantId || order.ownerOrgId !== args.user.companyId) {
      throw invoiceError("Order not found", 404);
    }
    const entity = await tx.financeLegalEntity.findFirst({ where: {
      tenantId: args.user.tenantId, companyId: order.ownerOrgId, isActive: true,
    }, select: { id: true } });
    if (!entity) throw invoiceError("Active owned financial legal entity required", 409);
    await tx.$queryRaw`SELECT id FROM "Invoice" WHERE "orderId" = ${order.id}::uuid FOR SHARE`;
    const current = await tx.invoice.findFirst({ where: { AND: [owned, { orderId: order.id }] } });
    if (current && (current.customerId !== order.customerId || current.customerEntityId !== order.customerEntityId)) {
      throw invoiceError("Invoice ownership conflicts with order", 409);
    }
    if (current?.status === InvoiceStatus.issued || current?.status === InvoiceStatus.paid) {
      if (!current.issuedAt || !current.issuedByUserId || !current.amount.isFinite() || !current.amount.gt(0) ||
          !current.fxRate.isFinite() || !current.fxRate.gt(0)) throw invoiceError("Invoice requires reconciliation", 409);
      if (args.dueAt !== undefined && (args.dueAt?.getTime() ?? null) !== (current.dueAt?.getTime() ?? null)) {
        throw invoiceError("Issued invoice intent conflicts with stored receipt", 409);
      }
      return current;
    }
    if (current?.status === InvoiceStatus.cancelled || current?.status === InvoiceStatus.credited) {
      throw invoiceError("Cancelled or credited invoice cannot be reissued", 409);
    }
    // Manual rows can forge rule/source keys; server seeds pass through Float.
    // No durable approved pricing acceptance exists. Never backfill ownership or invent FX.
    throw Object.assign(invoiceError("Approved exact pricing and FX acceptance required for invoice issuance", 409),
      { code: "INVOICE_PRICING_ACCEPTANCE_REQUIRED" });
  }, { maxWait: 3000, timeout: 10000 });

  return publicInvoice(invoice);
}

export async function listInvoicesForActor(args: {
  user: AppUser;
  cursor?: string;
  limit: number;
  status?: InvoiceStatus;
}) {
  const ownedWhere = await authorizedInvoiceWhere(args.user, "finance.invoices.read");
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) throw invoiceError("Invalid invoice limit", 400);
  const cursor = args.cursor ? await prisma.invoice.findFirst({ where: { AND: [ownedWhere, { id: args.cursor }] }, select: { id: true, createdAt: true } }) : null;
  if (args.cursor && !cursor) throw invoiceError("Invoice cursor not found", 404);
  const rows = await prisma.invoice.findMany({
    where: {
      ...(args.status ? { status: args.status } : null),
      AND: [ownedWhere, ...(cursor ? [{ OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }] : [])],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: args.limit + 1,
    select: {
      id: true,
      companyId: true,
      orderId: true,
      customerId: true,
      customerEntityId: true,
      invoiceNumber: true,
      amount: true,
      currency: true,
      fxRate: true,
      fxRateAsOf: true,
      status: true,
      paymentUrl: true,
      issuedByUserId: true,
      issuedAt: true,
      dueAt: true,
      createdAt: true,
      updatedAt: true,
      order: { select: { orderNumber: true } },
      customerEntity: { select: { id: true, name: true, companyName: true } },
    },
  });
  const hasMore = rows.length > args.limit;
  const items = hasMore ? rows.slice(0, args.limit) : rows;
  return {
    items: items.map(publicInvoice),
    nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
  };
}

export async function getInvoiceByOrder(orderId: string, actor: AppUser) {
  const where = await authorizedInvoiceWhere(actor, "finance.invoices.read");
  const invoice = await prisma.invoice.findFirst({ where: { AND: [where, { orderId }] },
    select: { id: true, invoiceNumber: true, companyId: true, orderId: true, status: true, amount: true, currency: true, fxRate: true, issuedAt: true, dueAt: true } });
  return invoice ? publicInvoice(invoice) : null;
}

/** Returns a private storage reference only after fresh document and parent-order authorization. */
export async function getAuthorizedInvoiceFile(id: string, actor: AppUser) {
  const where = await authorizedInvoiceWhere(actor, "payments.intents.read");
  const select = { id: true, invoiceKey: true } as const;
  const invoice = await prisma.invoice.findFirst({ where: { AND: [where, { orderId: id }] }, select })
    ?? await prisma.invoice.findFirst({ where: { AND: [where, { id }] }, select });
  if (!invoice?.invoiceKey) throw invoiceError("Invoice PDF not found", 404);
  return invoice.invoiceKey;
}
