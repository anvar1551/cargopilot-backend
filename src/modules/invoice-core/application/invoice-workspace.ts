import { z } from "zod";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import { authorizedInvoiceWhere } from "./invoiceAccess";
import {
  billingAuthority,
  billingOwner,
  billingHash,
  billingError,
} from "../../pricing-core/repo/billing-policy";
import { parseBillingPolicy } from "../../pricing-core/domain/billing-calculation";
import { requireCustomerEntityReference } from "../../customers-core/application/customerEntityRepo";
import {
  serviceInstruction,
  currentServiceObligation,
} from "../../pricing-core/repo/service-cash-basis";
const schema = z
  .object({
    view: z.enum(["invoices", "invoice", "orders", "order"]),
    id: z.string().uuid().optional(),
    q: z.string().trim().max(100).default(""),
    limit: z.coerce.number().int().min(1).max(20).default(10),
    cursor: z.string().max(1000).optional(),
  })
  .strict();
const invoiceSelect = {
  id: true,
  orderId: true,
  invoiceNumber: true,
  amount: true,
  currency: true,
  status: true,
  issuedByUserId: true,
  issuedAt: true,
  dueAt: true,
  invoiceKey: true,
  billingPayerCustomerEntityId: true,
  billingPriceApprovalId: true,
  order: { select: { orderNumber: true } },
  company: { select: { name: true } },
} as const;
/** Advisory no-store business projections. Issuance always revalidates its own accepted source. */
export async function readInvoiceWorkspace(u: AppUser, raw: unknown) {
  const q = schema.parse(raw),
    issuing = q.view === "orders" || q.view === "order",
    permission = issuing ? "finance.invoices.issue" : "finance.invoices.read";
  if (["invoice", "order"].includes(q.view) && !q.id)
    throw billingError("INVOICE_REFERENCE_REQUIRED", 400);
  const owned = await authorizedInvoiceWhere(u, permission);
  const binding = billingHash({
    user: u.id,
    tenant: u.tenantId,
    company: u.companyId,
    membership: u.companyMembershipId,
    view: q.view,
    q: q.q,
    limit: q.limit,
  });
  let after: string | undefined;
  if (q.cursor) {
    try {
      after = z
        .object({ binding: z.literal(binding), after: z.string().uuid() })
        .strict()
        .parse(JSON.parse(Buffer.from(q.cursor, "base64url").toString())).after;
    } catch {
      throw billingError("INVOICE_CURSOR_CONTEXT_REQUIRED", 400);
    }
  }
  const page = <T extends { id: string }>(rows: T[]) => ({
    items: rows.slice(0, q.limit),
    nextCursor:
      rows.length > q.limit
        ? Buffer.from(
            JSON.stringify({ binding, after: rows[q.limit - 1].id }),
          ).toString("base64url")
        : null,
  });
  return prisma.$transaction(
    async (tx) => {
      const company = await tx.organization.findFirst({
        where: { id: u.companyId!, tenantId: u.tenantId! },
        select: { name: true },
      });
      const payer = async (id: string | null) => {
        if (!id) return null;
        await requireCustomerEntityReference(u, id);
        return tx.customerEntity.findFirst({
          where: { id, tenantId: u.tenantId! },
          select: { name: true, companyName: true },
        });
      };
      const invoice = async (
        r: import("@prisma/client").Prisma.InvoiceGetPayload<{
          select: typeof invoiceSelect;
        }>,
      ) => {
        const employee = r.issuedByUserId
          ? await tx.user.findUnique({
              where: { id: r.issuedByUserId },
              select: { name: true },
            })
          : null;
        return {
          id: r.id,
          orderId: r.orderId,
          invoiceNumber: r.invoiceNumber,
          orderNumber: r.order.orderNumber,
          companyName: r.company.name,
          payer: await payer(r.billingPayerCustomerEntityId),
          issuerName: employee?.name ?? null,
          amount: r.amount.toFixed(4),
          currency: r.currency,
          status: r.status,
          issuedAt: r.issuedAt,
          dueAt: r.dueAt,
          hasFile: !!r.invoiceKey,
          priceApprovalId: r.billingPriceApprovalId,
          accounting:
            "Accounting execution is unavailable in this workspace. Issuance facts remain held where recorded.",
        };
      };
      if (!issuing) {
        const rows = await tx.invoice.findMany({
          where: {
            AND: [
              owned,
              ...(q.view === "invoice" ? [{ id: q.id }] : []),
              ...(after ? [{ id: { gt: after } }] : []),
              ...(q.q
                ? [
                    {
                      OR: [
                        {
                          invoiceNumber: {
                            contains: q.q,
                            mode: "insensitive" as const,
                          },
                        },
                        { order: { orderNumber: { contains: q.q } } },
                      ],
                    },
                  ]
                : []),
            ],
          },
          select: invoiceSelect,
          orderBy: { id: "asc" },
          take: q.view === "invoice" ? 1 : q.limit + 1,
        });
        if (q.view === "invoice") {
          if (!rows[0]) throw billingError("INVOICE_NOT_FOUND", 404);
          return invoice(rows[0]);
        }
        return page(await Promise.all(rows.map(invoice)));
      }
      const entity = await billingAuthority(tx, u, permission);
      const orderWhere = {
        AND: [
          owned.order!.is!,
          { tenantId: u.tenantId!, ownerOrgId: u.companyId! },
          ...(q.view === "order" ? [{ id: q.id }] : []),
          ...(after ? [{ id: { gt: after } }] : []),
          ...(q.q ? [{ orderNumber: { contains: q.q } }] : []),
        ],
      };
      const rows = await tx.order.findMany({
        where: orderWhere,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          currentPriceApprovalId: true,
        },
        orderBy: { id: "asc" },
        take: q.view === "order" ? 1 : q.limit + 1,
      });
      if (q.view === "orders") return page(rows);
      const o = rows[0];
      if (!o) throw billingError("BILLING_ORDER_NOT_FOUND", 404);
      const owner = { ...billingOwner(u), legalEntityId: entity.id },
        bill = await tx.orderBillTo.findFirst({
          where: { ...owner, orderId: o.id },
          select: { id: true, payerCustomerEntityId: true },
        });
      const accepted = o.currentPriceApprovalId
        ? await tx.orderPriceApproval.findFirst({
            where: {
              ...owner,
              orderId: o.id,
              snapshotId: o.currentPriceApprovalId,
            },
            include: { source: true },
          })
        : null;
      const reasons: string[] = [];
      let components: unknown[] = [],
        eligibleStates: string[] = [];
      if (!accepted) reasons.push("A current accepted price is required.");
      if (!bill || (accepted && accepted.billToId !== bill.id))
        reasons.push("An explicit matching bill-to payer is required.");
      if (accepted) {
        if (
          billingHash(accepted.source.content) !== accepted.source.contentHash
        )
          reasons.push("Accepted price evidence is inconsistent.");
        if (!accepted.total.gt(0))
          reasons.push(
            "A zero price cannot produce a collectible manual invoice.",
          );
        if (accepted.currency !== entity.baseCurrency)
          reasons.push(
            "Invoice currency must match the issuing entity base currency. FX is unavailable.",
          );
        components = ((accepted.source.content as any).components ?? []).map(
          (c: any) => ({
            type: c.type,
            code: c.code ?? null,
            amount: c.amount,
            basis: c.basis ?? null,
          }),
        );
        const policy = await tx.billingPolicyVersion.findFirst({
          where: {
            id: accepted.policyVersionId,
            ...owner,
            currency: accepted.currency,
            decisions: { some: { decision: "approved" } },
          },
        });
        if (!policy || billingHash(policy.content) !== policy.contentHash)
          reasons.push("An intact independently approved policy is required.");
        else {
          const config = parseBillingPolicy(policy.content);
          eligibleStates = config.billing.eligibleOrderStates;
          if (!eligibleStates.includes(o.status))
            reasons.push(
              "The current order state is not eligible under the accepted policy.",
            );
        }
        const instruction = await serviceInstruction(tx, o.id),
          basis = instruction ? await currentServiceObligation(tx, o.id) : null;
        if (
          instruction &&
          (!basis ||
            basis.priceApprovalId !== accepted.snapshotId ||
            basis.instructionId !== instruction.id)
        )
          reasons.push(
            "Cash instruction and accepted obligation do not agree.",
          );
      }
      const existing = await tx.invoice.findFirst({
        where: { AND: [owned, { orderId: o.id }] },
        select: { id: true, invoiceNumber: true },
      });
      if (existing)
        reasons.push(
          "An invoice already exists. Open it; do not issue another.",
        );
      return {
        order: o,
        companyName: company?.name ?? null,
        baseCurrency: entity.baseCurrency,
        payer: await payer(
          accepted?.payerCustomerEntityId ??
            bill?.payerCustomerEntityId ??
            null,
        ),
        price: accepted
          ? {
              id: accepted.snapshotId,
              total: accepted.total.toFixed(4),
              currency: accepted.currency,
              components,
            }
          : null,
        existing,
        eligibleStates,
        reasons,
        eligible: reasons.length === 0,
        accounting: "Held — accounting execution unavailable",
      };
    },
    { maxWait: 3000, timeout: 10000 },
  );
}
