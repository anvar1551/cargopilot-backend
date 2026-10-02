import { PaymentEnvironment, PaymentProvider, Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import { hasCompanyScope, requireTenantBoundOrderCompanyAuthority } from "../../orders-core/domain/company-authority";
import { authorityError } from "../../orders-core/domain/creation-authority";
import { decryptSecret } from "./paymentCrypto";

async function selected(user: AppUser, permission: string, requestedCompany?: string) {
  const membership = await requireTenantBoundOrderCompanyAuthority(prisma, user, permission);
  if (!hasCompanyScope(membership)) throw authorityError("Explicit selected-company payment scope required", 403);
  if (requestedCompany !== undefined && requestedCompany !== membership.companyId)
    throw authorityError("Selected payment company mismatch", 403);
  return {
    companyId: membership.companyId,
    company: { is: { id: membership.companyId, tenantId: membership.tenantId!,
      type: "company" as const, isActive: true, tenant: { is: { status: "active" as const } } } },
  };
}

function idRequired(id: string) {
  if (typeof id !== "string" || !id.trim()) throw authorityError("Provider config id required", 400);
}

function approvalRequired(): never {
  throw Object.assign(authorityError("Payment configuration requires independent durable approval", 409),
    { code: "PAYMENT_CONFIGURATION_APPROVAL_REQUIRED" });
}

const configReadSelect = {
  id: true, companyId: true, provider: true, environment: true, isEnabled: true,
  callbackPath: true, createdAt: true, updatedAt: true,
} satisfies Prisma.PaymentProviderConfigSelect;

export async function getCompanyPaymentPolicyForActor(args: { user: AppUser; companyId?: string }) {
  const context = await selected(args.user, "payments.providers.read", args.companyId);
  const setting = await prisma.companyPaymentSetting.findFirst({ where: context, select: {
    onlinePaymentsEnabled: true, defaultProvider: true, allowProviderOverride: true,
    createdAt: true, updatedAt: true,
  } });
  const globalPaymentsEnabled = process.env.PAYMENTS_ENABLED === "true";
  return { companyId: context.companyId, globalPaymentsEnabled,
    onlinePaymentsEnabled: setting?.onlinePaymentsEnabled ?? false,
    effectiveOnlinePaymentsEnabled: globalPaymentsEnabled && setting?.onlinePaymentsEnabled === true,
    defaultProvider: setting?.defaultProvider ?? null, allowProviderOverride: setting?.allowProviderOverride ?? false,
    createdAt: setting?.createdAt ?? null, updatedAt: setting?.updatedAt ?? null };
}

export async function listProviderConfigsForActor(args: { user: AppUser; companyId?: string;
  provider?: PaymentProvider; environment?: PaymentEnvironment; enabledOnly?: boolean }) {
  const context = await selected(args.user, "payments.providers.read", args.companyId);
  const rows = await prisma.paymentProviderConfig.findMany({ where: { ...context,
    ...(args.provider ? { provider: args.provider } : {}),
    ...(args.environment ? { environment: args.environment } : {}),
    ...(args.enabledOnly ? { isEnabled: true } : {}),
  }, orderBy: [{ provider: "asc" }, { environment: "asc" }], take: 8, select: configReadSelect });
  // Explicit DTO also keeps mock/alternate adapter surplus fields out of the API.
  return rows.map(row => ({ id: row.id, companyId: row.companyId, provider: row.provider,
    environment: row.environment, isEnabled: row.isEnabled, callbackPath: row.callbackPath,
    createdAt: row.createdAt, updatedAt: row.updatedAt }));
}

export async function listAvailableProvidersForActor(args: { user: AppUser; companyId?: string;
  environment?: PaymentEnvironment }) {
  const context = await selected(args.user, "payments.intents.create", args.companyId);
  const policy = await prisma.companyPaymentSetting.findFirst({ where: context,
    select: { onlinePaymentsEnabled: true, defaultProvider: true, allowProviderOverride: true } });
  if (process.env.PAYMENTS_ENABLED !== "true" || policy?.onlinePaymentsEnabled !== true) return [];
  // Only Stripe has the covered checkout/confirmation contract. Do not advertise contained providers.
  if (!policy.allowProviderOverride && policy.defaultProvider !== PaymentProvider.STRIPE) return [];
  const rows = await prisma.paymentProviderConfig.findMany({ where: { ...context,
    provider: PaymentProvider.STRIPE, isEnabled: true,
    ...(args.environment ? { environment: args.environment } : {}),
  }, orderBy: [{ provider: "asc" }, { environment: "asc" }], take: 2, select: {
    id: true, provider: true, environment: true, callbackPath: true, updatedAt: true,
    merchantId: true, serviceId: true, accountId: true,
  } });
  return rows.map(row => ({ id: row.id, provider: row.provider, environment: row.environment,
    callbackPath: row.callbackPath, integrationMode: "redirect" as const, supportsCheckoutRedirect: true,
    configuredFields: { merchantId: Boolean(row.merchantId), serviceId: Boolean(row.serviceId),
      accountId: Boolean(row.accountId) }, updatedAt: row.updatedAt }));
}

export async function upsertCompanyPaymentPolicyForActor(args: { user: AppUser; companyId: string;
  onlinePaymentsEnabled: boolean; defaultProvider?: PaymentProvider | null; allowProviderOverride?: boolean }) {
  await selected(args.user, "payments.providers.manage", args.companyId);
  return approvalRequired();
}

export async function upsertProviderConfigForActor(args: { user: AppUser; companyId: string;
  provider: PaymentProvider; environment: PaymentEnvironment; isEnabled?: boolean;
  merchantId?: string; serviceId?: string; accountId?: string; secret: string }) {
  await selected(args.user, "payments.providers.manage", args.companyId);
  return approvalRequired();
}

export async function patchProviderConfigForActor(args: { user: AppUser; id: string; isEnabled?: boolean;
  merchantId?: string; serviceId?: string; accountId?: string; secret?: string; environment?: PaymentEnvironment }) {
  idRequired(args.id);
  const context = await selected(args.user, "payments.providers.manage");
  const existing = await prisma.paymentProviderConfig.findFirst({ where: { ...context, id: args.id }, select: { id: true } });
  if (!existing) throw authorityError("Provider config not found", 404);
  return approvalRequired();
}

export function collectProviderConfigIssues(args: { provider: PaymentProvider; merchantId?: string | null;
  serviceId?: string | null; accountId?: string | null; secret?: string | null }) {
  const issues: string[] = [];
  const secret = args.secret?.trim();
  if (!secret || secret.length < 4) issues.push("secret is required and must be at least 4 chars");
  if (args.provider === PaymentProvider.CLICK) {
    if (!args.merchantId?.trim()) issues.push("merchantId is required for CLICK");
    if (!args.serviceId?.trim()) issues.push("serviceId is required for CLICK");
    if (!args.accountId?.trim()) issues.push("accountId (merchant_user_id) is required for CLICK");
  }
  if (args.provider === PaymentProvider.PAYME && !args.merchantId?.trim()) issues.push("merchantId (cashbox ID) is required for PAYME");
  if (args.provider === PaymentProvider.UZUM) {
    if (!args.serviceId?.trim()) issues.push("serviceId is required for UZUM");
    if (!args.accountId?.trim()) issues.push("accountId (BasicAuth username) is required for UZUM");
  }
  if (args.provider === PaymentProvider.STRIPE) {
    if (!secret?.startsWith("sk_")) issues.push("secret must be a Stripe secret key (sk_...) for STRIPE");
    if (!args.serviceId?.trim().startsWith("whsec_")) issues.push("serviceId must be Stripe webhook secret (whsec_...) for STRIPE");
  }
  return issues;
}

export async function testProviderConfigForActor(args: { user: AppUser; id: string }) {
  idRequired(args.id);
  const context = await selected(args.user, "payments.providers.manage");
  const config = await prisma.paymentProviderConfig.findFirst({ where: { ...context, id: args.id }, select: {
    ...configReadSelect, merchantId: true, serviceId: true, accountId: true, secretEncrypted: true,
  } });
  if (!config) throw authorityError("Provider config not found", 404);
  let issues: string[];
  try { issues = collectProviderConfigIssues({ ...config, secret: decryptSecret(config.secretEncrypted) }); }
  catch { issues = ["Stored credential could not be validated"]; }
  return { id: config.id, provider: config.provider, environment: config.environment,
    isEnabled: config.isEnabled, callbackPath: config.callbackPath,
    configuredFields: { merchantId: Boolean(config.merchantId), serviceId: Boolean(config.serviceId), accountId: Boolean(config.accountId) },
    healthy: issues.length === 0, issues, validationMode: "local-configuration-only" as const };
}
