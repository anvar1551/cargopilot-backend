import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import { authorityError } from "../../orders-core/domain/creation-authority";
import { integrationProviderContext } from "./provider-access";

type Domain = "carrier" | "sms" | "payment" | "webhook_sink";
type Environment = "sandbox" | "production";
type Status = "active" | "paused" | "disabled";
function contained(domain: Domain, deletion = false): never {
  const code = deletion ? "INTEGRATION_PROVIDER_HISTORY_REQUIRED" : domain === "payment"
    ? "INTEGRATION_FINANCE_CONFIGURATION_APPROVAL_REQUIRED" : "INTEGRATION_CONFIGURATION_WORKFLOW_REQUIRED";
  throw Object.assign(authorityError(deletion ? "Provider deletion requires a controlled history-preserving workflow"
    : domain === "payment" ? "Financial provider configuration requires independent durable approval"
    : "Provider configuration requires durable version and audit history", 409), { code });
}

async function owned(user: AppUser, id: string, permission: string) {
  const context = await integrationProviderContext(user, permission);
  if (typeof id !== "string" || !id.trim()) throw authorityError("Provider id required", 400);
  const provider = await prisma.integrationProvider.findFirst({ where: { ...context, id }, select: { id: true, domain: true } });
  if (!provider) throw authorityError("Integration provider not found", 404);
  return provider;
}

export async function upsertIntegrationProviderForActor(args: { user: AppUser; companyId: string; domain: Domain;
  providerCode: string; environment: Environment; status?: Status; capabilities?: unknown;
  rateLimitRps?: number | null; timeoutMs?: number; retryPolicyId?: string | null }) {
  await integrationProviderContext(args.user, "integration.provider.manage", args.companyId);
  if (typeof args.companyId !== "string" || !args.companyId.trim()) throw authorityError("Provider company required", 400);
  return contained(args.domain);
}
export async function updateIntegrationProviderStatusForActor(args: { user: AppUser; providerId: string; status: Status }) {
  const provider = await owned(args.user, args.providerId, "integration.provider.manage");
  return contained(provider.domain);
}
export async function deleteIntegrationProviderForActor(args: { user: AppUser; providerId: string }) {
  const provider = await owned(args.user, args.providerId, "integration.provider.manage");
  return contained(provider.domain, true);
}
export async function rotateIntegrationProviderSecretForActor(args: { user: AppUser; providerId: string; secretPayload: unknown; keyVersion?: number }) {
  const provider = await owned(args.user, args.providerId, "integration.provider.rotateSecret");
  return contained(provider.domain);
}
