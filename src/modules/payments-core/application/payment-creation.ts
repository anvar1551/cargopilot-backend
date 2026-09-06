import { createHash } from "crypto";
import { PaymentEnvironment, PaymentIntent, PaymentIntentStatus, PaymentProvider, Prisma, PrismaClient } from "@prisma/client";
import type { AppUser } from "../../../types/app-user";
import { authorityError } from "../../orders-core/domain/creation-authority";
import { hasCompanyScope, requireCompanyAuthority } from "../../orders-core/domain/company-authority";
import { CreatePaymentIntentInput, toCanonicalStatus } from "../domain/contracts";
import type { PaymentProviderAdapter, ResolvedProviderConfig } from "../infrastructure/providers/providerAdapter";
import { createPaymentIntentSchema } from "../shared/validation";

type Dependencies = {
  db: PrismaClient;
  resolveConfig: (args: { companyId: string; provider: PaymentProvider; environment: PaymentEnvironment }, tx: Prisma.TransactionClient) => Promise<ResolvedProviderConfig>;
  adapter: (provider: PaymentProvider) => PaymentProviderAdapter;
};

function digest(value: unknown) {
  let count = 0;
  const canonical = (item: unknown, depth = 0): unknown => {
    if (++count > 2000 || depth > 16) throw authorityError("Payment metadata exceeds structural limits");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map((child) => canonical(child, depth + 1));
    if (item && typeof item === "object" && Object.getPrototypeOf(item) === Object.prototype) {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical((item as Record<string, unknown>)[key], depth + 1)]));
    }
    throw authorityError("Payment metadata must be JSON");
  };
  const serialized = JSON.stringify(canonical(value));
  if (serialized.length > 16384) throw authorityError("Payment metadata is too large");
  return createHash("sha256").update(serialized).digest("hex");
}

export function invoiceMinorUnits(amount: Prisma.Decimal, currency: string): bigint {
  if (!["UZS", "USD", "CNY"].includes(currency)) throw authorityError("Unsupported invoice currency", 409);
  const minor = amount.mul(100);
  if (!minor.isFinite() || !minor.isInteger() || minor.lte(0) || minor.gt("9223372036854775807")) {
    throw authorityError("Invoice amount cannot be represented exactly in supported minor units", 409);
  }
  return BigInt(minor.toFixed(0));
}

function result(intent: PaymentIntent, reused: boolean) {
  return {
    paymentIntentId: intent.id, status: toCanonicalStatus(intent.status),
    checkoutUrl: intent.providerCheckoutUrl, providerPaymentId: intent.providerPaymentId, reused,
  };
}

/** The database unique key is the reservation; only its successful creator calls a provider. */
export async function createAuthorizedPayment(
  args: { user: AppUser; input: CreatePaymentIntentInput }, deps: Dependencies,
) {
  const input = createPaymentIntentSchema.parse(args.input);
  const requestDigest = digest({ provider: input.provider ?? null, returnUrl: input.returnUrl ?? null, metadata: input.metadata ?? {} });
  const reservation = async () => deps.db.$transaction(async (tx) => {
    const membership = await requireCompanyAuthority(tx, args.user, "payments.intents.create");
    const companyId = membership.companyId;
    if (input.companyId !== undefined && input.companyId !== companyId) throw authorityError("Order company mismatch", 403);
    // Bounded database lock wait; no network operation occurs inside this transaction.
    await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Order" WHERE id = ${input.orderId}::uuid AND "ownerOrgId" = ${companyId}::uuid FOR UPDATE`;
    if (locked.length !== 1) throw authorityError("Order not accessible", 404);
    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      select: { id: true, ownerOrgId: true, currentWarehouseId: true, customerEntityId: true, paymentType: true, paymentState: true, status: true },
    });
    if (!order || order.ownerOrgId !== companyId || (!hasCompanyScope(membership) &&
        !membership.scopes.some((scope) => scope.scopeType === "warehouse" && !!order.currentWarehouseId && scope.scopeRefId === order.currentWarehouseId))) {
      throw authorityError("Order not accessible", 404);
    }
    await tx.$queryRaw`SELECT id FROM "Invoice" WHERE "orderId" = ${order.id}::uuid FOR SHARE`;
    const invoice = await tx.invoice.findUnique({ where: { orderId: order.id } });
    if (!invoice || invoice.companyId !== companyId || !invoice.issuedAt || !invoice.issuedByUserId ||
        !["issued", "paid"].includes(invoice.status) || invoice.customerEntityId !== order.customerEntityId) {
      throw authorityError("An issued invoice belonging to the order company is required", 409);
    }
    const legalEntity = await tx.financeLegalEntity.findUnique({ where: { companyId }, select: { id: true, companyId: true, isActive: true } });
    if (!legalEntity?.isActive || legalEntity.companyId !== companyId) throw authorityError("Active order legal entity required", 409);
    const currency = invoice.currency;
    const amountMinor = invoiceMinorUnits(invoice.amount, currency);
    if ((input.amountMinor !== undefined && input.amountMinor !== amountMinor) ||
        (input.currency !== undefined && input.currency !== currency)) throw authorityError("Payment amount/currency differs from the issued invoice", 409);
    if (order.status === "cancelled" || order.status === "returned" || !["CARD", "TRANSFER"].includes(order.paymentType ?? "")) {
      throw authorityError("Order is not eligible for online payment", 409);
    }
    const authorityDigest = digest({ companyId, orderId: order.id, invoiceId: invoice.id,
      legalEntityId: legalEntity.id, amountMinor: amountMinor.toString(), currency, issuedAt: invoice.issuedAt.toISOString() });
    const existing = await tx.paymentIntent.findUnique({ where: { companyId_idempotencyKey: { companyId, idempotencyKey: input.idempotencyKey } } });
    if (existing) {
      const binding = existing.metadataJson as Record<string, unknown> | null;
      if (existing.orderId !== order.id || existing.companyId !== companyId || existing.amountMinor !== amountMinor || existing.currency !== currency ||
          binding?.phase0bRequestDigest !== requestDigest || binding?.phase0bAuthorityDigest !== authorityDigest) {
        throw authorityError("Idempotency key conflicts with the existing payment request", 409);
      }
      return { intent: existing, config: null };
    }
    if (invoice.status !== "issued" || !["UNPAID", "FAILED"].includes(order.paymentState)) {
      throw authorityError("Order is not eligible for a new online payment", 409);
    }
    // Same-order requests with different keys also serialize on the order row.
    // Legacy failed attempts can have an unknown external outcome; never infer safe recharging.
    const prior = await tx.paymentIntent.findFirst({ where: { orderId: order.id } });
    if (prior) throw authorityError("An existing order payment requires reuse or reconciliation", 409);
    const policy = await tx.companyPaymentSetting.findUnique({ where: { companyId } });
    if (process.env.PAYMENTS_ENABLED !== "true" || !policy?.onlinePaymentsEnabled) throw authorityError("Online payments are disabled for this company", 409);
    const provider = input.provider ?? policy.defaultProvider;
    if (!provider || (input.provider && !policy.allowProviderOverride && input.provider !== policy.defaultProvider)) throw authorityError("Payment provider is not permitted", 409);
    const environment = process.env.PAYMENTS_ENVIRONMENT;
    if (environment !== "TEST" && environment !== "PRODUCTION") throw authorityError("Explicit payment environment configuration required", 409);
    const config = await deps.resolveConfig({ companyId, provider, environment }, tx);
    if (!config.isEnabled || config.companyId !== companyId || config.provider !== provider || config.environment !== environment) throw authorityError("Payment provider context mismatch", 409);
    // These adapters do not transmit a currency field; do not silently reinterpret FX amounts.
    if (provider !== "STRIPE" && currency !== "UZS") throw authorityError("Provider requires a UZS invoice", 409);
    if (provider === "CLICK" && environment !== "PRODUCTION") throw authorityError("CLICK test endpoint is not established by the current adapter", 409);
    if (provider === "STRIPE" && !config.secretPlain.startsWith(environment === "TEST" ? "sk_test_" : "sk_live_") &&
        !config.secretPlain.startsWith(environment === "TEST" ? "rk_test_" : "rk_live_")) throw authorityError("Stripe credential environment mismatch", 409);
    if (provider === "STRIPE" && amountMinor > BigInt(Number.MAX_SAFE_INTEGER)) throw authorityError("Amount exceeds provider exact integer range", 409);
    const intent = await tx.paymentIntent.create({ data: {
      orderId: order.id, companyId, provider, providerConfigId: config.id, environment,
      amountMinor, currency, status: "PENDING", idempotencyKey: input.idempotencyKey,
      metadataJson: { phase0bRequestDigest: requestDigest, phase0bAuthorityDigest: authorityDigest, invoiceId: invoice.id, legalEntityId: legalEntity.id },
    } });
    return { intent, config };
  }, { maxWait: 2000, timeout: 8000 });

  let reserved: Awaited<ReturnType<typeof reservation>>;
  try {
    reserved = await reservation();
  } catch (error) {
    // A different order may race on the same company/key. Re-read through all authorization
    // and fingerprint checks after the winning transaction commits. No blind provider retry.
    if ((error as { code?: string }).code !== "P2002") throw error;
    reserved = await reservation();
  }
  if (!reserved.config) return result(reserved.intent, true);
  const { intent, config } = reserved;
  let providerResult: Awaited<ReturnType<PaymentProviderAdapter["createPayment"]>> | undefined;
  try {
    providerResult = await deps.adapter(config.provider).createPayment({ config, intent });
  } catch {
    // Failure/timeout does not prove that no external operation happened. Persist ambiguity;
    // do not log provider exceptions or automatically dispatch this intent again.
  }
  await deps.db.$transaction(async (tx) => {
    await tx.paymentAttempt.create({ data: {
      paymentIntentId: intent.id, provider: config.provider,
      status: providerResult ? "ACCEPTED" : "ERROR",
      errorMessage: providerResult ? null : "Provider initiation outcome unknown; reconciliation required",
    } });
    // A verified callback may have settled the intent while initiation was in flight.
    // Never overwrite that state or write an older state back onto the order.
    await tx.paymentIntent.updateMany({ where: { id: intent.id, companyId: intent.companyId, status: PaymentIntentStatus.PENDING }, data: {
      status: providerResult?.checkoutUrl ? "REQUIRES_ACTION" : "PENDING",
      providerPaymentId: providerResult?.providerPaymentId,
      providerInvoiceId: providerResult?.providerInvoiceId,
      providerCheckoutUrl: providerResult?.checkoutUrl,
    } });
  }, { maxWait: 2000, timeout: 8000 });
  const stored = await deps.db.paymentIntent.findUnique({ where: { id: intent.id } });
  if (!stored) throw authorityError("Payment result unavailable", 503);
  return result(stored, false);
}
