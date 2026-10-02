import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import { authorityError } from "../../orders-core/domain/creation-authority";
import { integrationProviderContext } from "./provider-access";

export type IntegrationMetadataDomain = "carrier" | "sms" | "payment" | "webhook_sink";
const domains: IntegrationMetadataDomain[] = ["carrier", "sms", "payment", "webhook_sink"];
export function metadataPage(value: number | undefined, fallback: number, max: number) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > max))
    throw authorityError("Invalid integration pagination", 400);
  return value ?? fallback;
}
export async function integrationMetadataScope(user: AppUser, companyId?: string, domain?: IntegrationMetadataDomain, providerCode?: string) {
  const context = await integrationProviderContext(user, "integration.outbox.read", companyId);
  if (domain !== undefined && !domains.includes(domain)) throw authorityError("Invalid integration domain", 400);
  if (providerCode !== undefined && (typeof providerCode !== "string" || !/^[a-z0-9_-]{1,64}$/i.test(providerCode.trim())))
    throw authorityError("Invalid integration provider code", 400);
  const providers = await prisma.integrationProvider.findMany({
    where: { ...context, ...(domain ? { domain } : {}), ...(providerCode ? { providerCode: providerCode.trim().toLowerCase() } : {}) },
    select: { id: true, domain: true, providerCode: true, environment: true }, orderBy: { id: "asc" }, take: 101,
  });
  if (providers.length > 100) throw Object.assign(authorityError("Integration read capacity exceeded", 409), { code: "INTEGRATION_READ_CAPACITY" });
  return { context, providers };
}
