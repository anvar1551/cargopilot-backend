import { createHash } from "crypto";
import { stableDraftJson } from "./draft-intent";
import { createAccountSchema } from "../transport/validation";
import type { CreateAccountCommand } from "../application/finance.port";

/** Same bounded normalized input for HTTP and alternate repository callers. No money or approval authority. */
export function normalizeAccountIntent(command: CreateAccountCommand) {
  const { companyId, actorUserId, ...input } = command;
  const parsed = createAccountSchema.parse(input);
  return { companyId, actorUserId, ...parsed, operationId: parsed.operationId.toLowerCase(),
    parentId: parsed.parentId?.toLowerCase() ?? null, currency: parsed.currency ?? null,
    description: parsed.description ?? null, metadata: parsed.metadata ?? null };
}
export function accountIntentHash(intent: ReturnType<typeof normalizeAccountIntent>, context: {
  tenantId: string; companyId: string; companyMembershipId: string; tenantMembershipId: string; userId: string;
}, legalEntityId: string) {
  return createHash("sha256").update(stableDraftJson({ version: 1, intent, context: {
    tenantId: context.tenantId, companyId: context.companyId, companyMembershipId: context.companyMembershipId,
    tenantMembershipId: context.tenantMembershipId, userId: context.userId,
  }, legalEntityId })).digest("hex");
}
export function projectCreatedAccount(account: any) {
  return Object.fromEntries(["id", "legalEntityId", "code", "name", "type", "status", "parentId", "allowPosting", "isControlAccount",
    "currency", "description", "createdAt", "updatedAt"].map(key => [key, account[key] instanceof Date ? account[key].toISOString() : account[key]]));
}
