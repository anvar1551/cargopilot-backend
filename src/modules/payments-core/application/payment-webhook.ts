import { createHash } from "crypto";
import { Prisma, PrismaClient, PaymentProvider } from "@prisma/client";
import type { PaymentProviderAdapter, ResolvedProviderConfig } from "../infrastructure/providers/providerAdapter";
import { authorityError } from "../../orders-core/domain/creation-authority";
import { invoiceMinorUnits, invoicePaymentAuthorityDigest } from "./payment-creation";
import { paymentWebhookMetadata } from "../../../utils/webhookMetadata";
import { withPaymentCallbackAdmission } from "./callback-admission";

type Dependencies = { db: PrismaClient | (() => PrismaClient); adapter: (provider: PaymentProvider) => PaymentProviderAdapter;
  resolve: (config: Prisma.PaymentProviderConfigGetPayload<{}>) => ResolvedProviderConfig };
type Input = { provider: PaymentProvider; body: unknown; headers: Record<string, unknown>; rawBody?: string | Buffer };
function reject(code: string, status = 409): never { throw Object.assign(authorityError("Payment callback cannot be applied", status), { code }); }
function record(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function boundedId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value); }
function minor(value: unknown) { if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) reject("PAYMENT_MONETARY_PROOF_REQUIRED"); return BigInt(value); }
const sourceSelect = { id: true, companyId: true, orderId: true, provider: true, environment: true, providerConfigId: true,
  providerInvoiceId: true, providerPaymentId: true, amountMinor: true, currency: true, status: true, metadataJson: true,
  providerConfig: true } satisfies Prisma.PaymentIntentSelect;
type Source = Prisma.PaymentIntentGetPayload<{ select: typeof sourceSelect }>;

async function authority(db: Prisma.TransactionClient | PrismaClient, intent: Source) {
  const config = intent.providerConfig;
  if (!config.isEnabled || config.id !== intent.providerConfigId || config.companyId !== intent.companyId || config.provider !== intent.provider || config.environment !== intent.environment) reject("PAYMENT_PROVIDER_BINDING_REQUIRED");
  const company = await db.organization.findFirst({ where: { id: intent.companyId, type: "company", isActive: true, tenantId: { not: null }, tenant: { is: { status: "active" } } }, select: { tenantId: true } });
  if (!company?.tenantId) reject("PAYMENT_OWNER_REQUIRED");
  const order = await db.order.findFirst({ where: { id: intent.orderId, ownerOrgId: intent.companyId, tenantId: company.tenantId },
    select: { id: true, tenantId: true, ownerOrgId: true, customerEntityId: true, status: true, paymentType: true, paymentState: true, serviceCharge: true, _count: { select: { cashCollections: true } } } });
  const invoice = await db.invoice.findUnique({ where: { orderId: intent.orderId } });
  const entity = await db.financeLegalEntity.findUnique({ where: { companyId: intent.companyId }, select: { id: true, tenantId: true, companyId: true, isActive: true } });
  if (!order || !invoice || !entity?.isActive || entity.tenantId !== company.tenantId || invoice.tenantId !== company.tenantId ||
    invoice.companyId !== intent.companyId || invoice.orderId !== order.id || invoice.customerEntityId !== order.customerEntityId ||
    !invoice.issuedAt || !invoice.issuedByUserId || !["issued", "paid"].includes(invoice.status) || !["CARD", "TRANSFER"].includes(order.paymentType ?? "") ||
    ["cancelled", "returned"].includes(order.status)) reject("PAYMENT_SOURCE_BINDING_REQUIRED");
  const amount = invoiceMinorUnits(invoice.amount, invoice.currency), metadata = record(intent.metadataJson);
  if (amount !== intent.amountMinor || invoice.currency !== intent.currency || metadata.invoiceId !== invoice.id || metadata.legalEntityId !== entity.id ||
    metadata.phase0bAuthorityDigest !== invoicePaymentAuthorityDigest({ companyId: intent.companyId, orderId: order.id, invoiceId: invoice.id, legalEntityId: entity.id, amountMinor: amount, currency: invoice.currency, issuedAt: invoice.issuedAt })) reject("PAYMENT_INVOICE_AUTHORITY_REQUIRED");
  return { order, invoice, entity, tenantId: company.tenantId };
}

/** A verified event is evidence, never generic service authorization. Only supported exact Stripe confirmations execute. */
export async function acceptPaymentWebhook(input: Input, deps: Dependencies) {
  return withPaymentCallbackAdmission(async () => {
    if (input.provider !== "STRIPE") reject("PAYMENT_PROVIDER_TRANSACTION_BINDING_REQUIRED");
    const raw = input.rawBody;
    if (!raw || Buffer.byteLength(raw) > 65536) reject("PAYMENT_RAW_BODY_REQUIRED", 400);
    const db = typeof deps.db === "function" ? deps.db() : deps.db;
    return applyPaymentWebhook(input, { ...deps, db });
  });
}

async function applyPaymentWebhook(input: Input, deps: Dependencies & { db: PrismaClient }) {
  if (input.provider !== "STRIPE") reject("PAYMENT_PROVIDER_TRANSACTION_BINDING_REQUIRED");
  const raw = typeof input.rawBody === "string" ? Buffer.from(input.rawBody) : input.rawBody;
  if (!raw?.length || raw.length > 65536) reject("PAYMENT_RAW_BODY_REQUIRED", 400);
  let parsed: Record<string, any>;
  try { parsed = record(JSON.parse(raw.toString("utf8"))); } catch { reject("PAYMENT_BODY_INVALID", 400); }
  // Only a stored external booking reference selects a verification credential.
  // Metadata IDs and caller-supplied company/tenant/order are never lookup authority.
  const object = record(record(parsed.data).object);
  const session = typeof parsed.type === "string" && parsed.type.startsWith("checkout.session.");
  const payment = typeof parsed.type === "string" && parsed.type.startsWith("payment_intent.");
  if ((!session && !payment) || !boundedId(object.id)) reject("PAYMENT_BOOKING_REQUIRED");
  const { candidate, initial } = await deps.db.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '3s'`;
    await tx.$executeRaw`SET LOCAL lock_timeout = '1s'`;
    const candidates = await tx.paymentIntent.findMany({ where: { provider: "STRIPE", ...(session ? { providerInvoiceId: object.id } : { providerPaymentId: object.id }) }, take: 2, select: sourceSelect });
    if (candidates.length !== 1) reject("PAYMENT_BOOKING_AMBIGUOUS");
    return { candidate: candidates[0], initial: await authority(tx, candidates[0]) };
  }, { maxWait: 2000, timeout: 5000 });
  const configVersion = createHash("sha256").update(JSON.stringify(candidate.providerConfig)).digest("hex");
  const verified = await deps.adapter("STRIPE").verifyWebhook({ provider: "STRIPE", environment: candidate.environment,
    body: parsed, rawBody: raw, headers: input.headers as Record<string, string | string[] | undefined>, config: deps.resolve(candidate.providerConfig) });
  if (!verified.isValid) reject("PAYMENT_SIGNATURE_INVALID", 403);
  const event = record(verified.rawEvent), value = record(record(event.data).object), metadata = record(value.metadata);
  if (!boundedId(event.id) || typeof event.livemode !== "boolean" || (event.livemode ? "PRODUCTION" : "TEST") !== candidate.environment || event.type !== parsed.type || value.id !== object.id) reject("PAYMENT_VERIFIED_EVENT_CONFLICT");
  for (const [field, expected] of Object.entries({ paymentIntentId: candidate.id, orderId: candidate.orderId, companyId: candidate.companyId })) if (metadata[field] !== undefined && metadata[field] !== expected) reject("PAYMENT_VERIFIED_EVENT_CONFLICT");
  if (value.client_reference_id !== undefined && value.client_reference_id !== null && value.client_reference_id !== candidate.id) reject("PAYMENT_VERIFIED_EVENT_CONFLICT");
  if (candidate.providerConfig.accountId && event.account !== candidate.providerConfig.accountId) reject("PAYMENT_PROVIDER_ACCOUNT_CONFLICT");
  if (!candidate.providerConfig.accountId && event.account !== undefined) reject("PAYMENT_PROVIDER_ACCOUNT_CONFLICT");
  let amount: bigint, providerPaymentId: string;
  if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
    if (value.payment_status !== "paid" || value.status !== "complete" || !boundedId(value.payment_intent)) reject("PAYMENT_MONETARY_PROOF_REQUIRED");
    amount = minor(value.amount_total); providerPaymentId = value.payment_intent;
  } else if (event.type === "payment_intent.succeeded") {
    if (value.status !== "succeeded") reject("PAYMENT_MONETARY_PROOF_REQUIRED");
    amount = minor(value.amount); if (minor(value.amount_received) !== amount) reject("PAYMENT_MONETARY_PROOF_REQUIRED"); providerPaymentId = value.id;
  } else reject("PAYMENT_TRANSITION_UNSUPPORTED");
  if (typeof value.currency !== "string" || !/^[a-zA-Z]{3}$/.test(value.currency)) reject("PAYMENT_MONETARY_PROOF_REQUIRED");
  const currency = value.currency.toUpperCase();
  if (amount !== candidate.amountMinor || currency !== candidate.currency || (candidate.providerPaymentId && candidate.providerPaymentId !== providerPaymentId)) reject("PAYMENT_MONETARY_PROOF_CONFLICT");
  const proof = { eventId: event.id, type: event.type, bookingId: value.id, providerPaymentId, amountMinor: amount.toString(), currency, environment: candidate.environment };
  const fingerprint = createHash("sha256").update(JSON.stringify(proof)).digest("hex");
  const key = `${candidate.providerConfigId}:${event.id}`;
  const outcome = await deps.db.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`; await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
    // Match checkout's order-before-intent ordering; no provider call inside the transaction.
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${candidate.orderId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "PaymentIntent" WHERE id=${candidate.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "PaymentProviderConfig" WHERE id=${candidate.providerConfigId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM "Invoice" WHERE "orderId"=${candidate.orderId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id=${initial.tenantId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id=${candidate.companyId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM "FinanceLegalEntity" WHERE "companyId"=${candidate.companyId}::uuid FOR SHARE`;
    const current = await tx.paymentIntent.findUnique({ where: { id: candidate.id }, select: sourceSelect });
    if (!current || current.orderId !== candidate.orderId || current.companyId !== candidate.companyId || current.provider !== "STRIPE" || current.environment !== candidate.environment || current.providerConfigId !== candidate.providerConfigId ||
      createHash("sha256").update(JSON.stringify(current.providerConfig)).digest("hex") !== configVersion) reject("PAYMENT_CURRENT_BINDING_CONFLICT");
    const context = await authority(tx, current);
    if (current.amountMinor !== amount || current.currency !== currency || (current.providerPaymentId && current.providerPaymentId !== providerPaymentId) ||
      (session ? current.providerInvoiceId !== value.id : current.providerPaymentId !== value.id)) reject("PAYMENT_CURRENT_BINDING_CONFLICT");
    const where = { provider_environment_idempotencyKey: { provider: current.provider, environment: current.environment, idempotencyKey: key } };
    const existing = await tx.paymentWebhookEvent.findUnique({ where });
    if (existing) {
      if (existing.paymentIntentId !== current.id || existing.companyId !== current.companyId || !existing.signatureValid || existing.processStatus !== "PROCESSED" || record(existing.payloadJson).fingerprint !== fingerprint) reject("PAYMENT_EVENT_ID_CONFLICT");
      return { duplicate: true, eventId: existing.id };
    }
    // Online-to-cash allocation uses legacy Float/custody logic without approved
    // exact allocation authority. Never silently settle it or fabricate FX/posting.
    if (context.order.serviceCharge !== 0 || context.order._count.cashCollections !== 0) reject("PAYMENT_CASH_ALLOCATION_REQUIRED");
    if (!["PENDING", "REQUIRES_ACTION", "PROCESSING", "SUCCEEDED"].includes(current.status) ||
      !["UNPAID", "PENDING", "PAID"].includes(context.order.paymentState) || (current.status === "SUCCEEDED" && context.order.paymentState !== "PAID") ||
      (current.status !== "SUCCEEDED" && context.order.paymentState === "PAID")) reject("PAYMENT_TRANSITION_CONFLICT");
    if (current.status === "SUCCEEDED") {
      const prior = await tx.paymentWebhookEvent.findFirst({ where: { paymentIntentId: current.id, companyId: current.companyId, provider: current.provider,
        environment: current.environment, signatureValid: true, processStatus: "PROCESSED", payloadJson: { path: ["providerPaymentId"], equals: providerPaymentId } }, select: { id: true } });
      if (!prior || await tx.paymentLedgerEntry.count({ where: { paymentIntentId: current.id, companyId: current.companyId, orderId: current.orderId,
        provider: current.provider, currency, amountMinor: amount, entryType: "payment", reference: prior.id } }) !== 1) reject("PAYMENT_LEGACY_CONFIRMATION_REQUIRED");
    }
    const receipt = await tx.paymentWebhookEvent.create({ data: { companyId: current.companyId, provider: current.provider, environment: current.environment,
      paymentIntentId: current.id, externalEventId: event.id, idempotencyKey: key, signatureValid: true, processStatus: "PROCESSED", processedAt: new Date(),
      headersJson: paymentWebhookMetadata(input.headers, raw, parsed, true), payloadJson: { ...proof, fingerprint } } });
    if (current.status !== "SUCCEEDED") {
      await tx.paymentIntent.update({ where: { id: current.id }, data: { status: "SUCCEEDED", providerPaymentId } });
      await tx.order.updateMany({ where: { id: current.orderId, tenantId: context.tenantId, ownerOrgId: current.companyId, paymentState: context.order.paymentState }, data: { paymentState: "PAID" } }).then(result => { if (result.count !== 1) reject("PAYMENT_TRANSITION_CONFLICT"); });
      await tx.paymentAttempt.create({ data: { paymentIntentId: current.id, provider: current.provider, status: "ACCEPTED" } });
      await tx.paymentLedgerEntry.create({ data: { paymentIntentId: current.id, companyId: current.companyId, orderId: current.orderId, provider: current.provider, currency, amountMinor: amount, entryType: "payment", reference: receipt.id } });
    }
    return { duplicate: false, eventId: receipt.id };
  }, { maxWait: 2000, timeout: 10000 }).catch(error => {
    // Different orders can compete for one configured event identity. Database
    // uniqueness rolls the losing transaction back; never retry business effects.
    if (error?.code === "P2002") reject("PAYMENT_EVENT_ID_CONFLICT");
    throw error;
  });
  // A receipt is returned only after commit. No FX/posting/ticket/queue effects.
  return { ok: true, eventId: event.id, webhookEventId: outcome.eventId, duplicate: outcome.duplicate };
}
