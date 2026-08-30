import { InvoiceStatus, Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import { enqueueCargoPilotDomainEventTx } from "../../analytics-core/infrastructure/analyticsOutbox";
import { authorize, buildOrderScopeWhere } from "../../identity-access";
import { resolvePayableTotalFromPricing } from "../../orders-legs/pricing";

const SUPPORTED_CURRENCIES = new Set(["UZS", "USD", "CNY"]);

function invoiceError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode });
}

function publicInvoice<T extends { amount: Prisma.Decimal; fxRate: Prisma.Decimal }>(invoice: T) {
  return {
    ...invoice,
    amount: invoice.amount.toFixed(4),
    fxRate: invoice.fxRate.toFixed(10),
  };
}

export async function issueOrderInvoiceForActor(args: {
  user: AppUser;
  orderId: string;
  dueAt?: Date | null;
}) {
  await authorize(args.user, "finance.invoices.issue");
  const scopeWhere = (await buildOrderScopeWhere(args.user)) ?? { id: "__no_access__" };
  const order = await prisma.order.findFirst({
    where: { AND: [{ id: args.orderId }, scopeWhere] },
    select: {
      id: true,
      orderNumber: true,
      ownerOrgId: true,
      customerId: true,
      customerEntityId: true,
    },
  });
  if (!order) throw invoiceError("Order not found", 404);
  if (!order.ownerOrgId) throw invoiceError("Order does not have a company scope", 409);

  const pricing = await resolvePayableTotalFromPricing(order.id);
  if (!pricing || pricing.amountMajor <= 0) {
    throw invoiceError("Order has no authoritative payable pricing snapshot", 409);
  }
  const currency = pricing.currency.trim().toUpperCase();
  if (!SUPPORTED_CURRENCIES.has(currency)) {
    throw invoiceError("Invoice currency must be UZS, USD, or CNY", 400);
  }
  const fxRate = pricing.fxRate ?? "1";
  const now = new Date();
  const invoiceNumber = `INV-${order.orderNumber}`;

  const invoice = await prisma.$transaction(async (tx) => {
    const current = await tx.invoice.findUnique({ where: { orderId: order.id } });
    if (current?.status === InvoiceStatus.issued || current?.status === InvoiceStatus.paid) {
      return current;
    }
    if (current?.status === InvoiceStatus.cancelled || current?.status === InvoiceStatus.credited) {
      throw invoiceError("Cancelled or credited invoice cannot be reissued", 409);
    }

    const issued = current
      ? await tx.invoice.update({
          where: { id: current.id },
          data: {
            companyId: order.ownerOrgId!,
            customerId: order.customerId,
            customerEntityId: order.customerEntityId,
            invoiceNumber,
            amount: new Prisma.Decimal(pricing.amountMajor),
            currency,
            fxRate: new Prisma.Decimal(fxRate),
            fxRateAsOf: pricing.fxRateAsOf,
            status: InvoiceStatus.issued,
            issuedByUserId: args.user.id,
            issuedAt: now,
            dueAt: args.dueAt ?? null,
            metadataJson: {
              pricingSource: pricing.source,
              pricingComponentCount: pricing.componentCount,
              baseCurrency: pricing.baseCurrency,
            },
          },
        })
      : await tx.invoice.create({
          data: {
            companyId: order.ownerOrgId!,
            orderId: order.id,
            customerId: order.customerId,
            customerEntityId: order.customerEntityId,
            invoiceNumber,
            amount: new Prisma.Decimal(pricing.amountMajor),
            currency,
            fxRate: new Prisma.Decimal(fxRate),
            fxRateAsOf: pricing.fxRateAsOf,
            status: InvoiceStatus.issued,
            issuedByUserId: args.user.id,
            issuedAt: now,
            dueAt: args.dueAt ?? null,
            metadataJson: {
              pricingSource: pricing.source,
              pricingComponentCount: pricing.componentCount,
              baseCurrency: pricing.baseCurrency,
            },
          },
        });

    const sourceEventId = `invoice:${issued.id}:issued`;
    await enqueueCargoPilotDomainEventTx(tx, {
      id: `finance:${sourceEventId}`,
      type: "finance_source_event",
      tenantScope: `company:${order.ownerOrgId}`,
      entityId: order.id,
      occurredAt: now.toISOString(),
      payload: {
        schemaVersion: 1,
        sourceEventId,
        companyId: order.ownerOrgId,
        sourceType: "invoice",
        eventType: "invoice.issued",
        sourceId: issued.id,
        actorUserId: args.user.id,
        occurredAt: now.toISOString(),
        documentDate: now.toISOString(),
        postingDate: now.toISOString(),
        currency,
        fxRate,
        fxRateAsOf: pricing.fxRateAsOf?.toISOString() ?? null,
        amounts: { gross_amount: issued.amount.toFixed(4) },
        dimensions: {
          orderId: order.id,
          customerEntityId: order.customerEntityId ?? undefined,
        },
        attributes: {
          invoiceStatus: issued.status,
          pricingSource: pricing.source,
        },
        description: `Invoice ${invoiceNumber} issued for order ${order.orderNumber}`,
        metadata: {
          invoiceNumber,
          pricingComponentCount: pricing.componentCount,
          baseCurrency: pricing.baseCurrency,
          dueAt: args.dueAt?.toISOString() ?? null,
        },
      },
    });
    return issued;
  });

  return publicInvoice(invoice);
}

export async function listInvoicesForActor(args: {
  user: AppUser;
  cursor?: string;
  limit: number;
  status?: InvoiceStatus;
}) {
  await authorize(args.user, "finance.invoices.read");
  const scopeWhere = (await buildOrderScopeWhere(args.user)) ?? { id: "__no_access__" };
  const rows = await prisma.invoice.findMany({
    where: {
      ...(args.status ? { status: args.status } : null),
      order: { is: scopeWhere },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: args.limit + 1,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : null),
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
      invoiceKey: true,
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

export async function getInvoiceByOrder(orderId: string) {
  return prisma.invoice.findUnique({ where: { orderId } });
}
