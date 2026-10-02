import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import { authorityError } from "../../orders-core/domain/creation-authority";
import { integrationProviderContext } from "./provider-access";

async function requireRecovery(args: { user: AppUser; outboxId: string }): Promise<never> {
  const context = await integrationProviderContext(args.user, "integration.outbox.replay");
  if (typeof args.outboxId !== "string" || !args.outboxId.trim()) throw authorityError("Outbox id required", 400);
  const row = await prisma.integrationOutbox.findFirst({ where: { ...context, id: args.outboxId }, select: { id: true } });
  if (!row) throw authorityError("Outbox record not found", 404);
  // A manual retry may not reset a lease or mint a new operation identity to
  // bypass an uncertain original effect. Automated durable retry policy is separate.
  throw Object.assign(authorityError("Manual outbox recovery requires accepted source and reconciliation authority", 409),
    { code: "INTEGRATION_OUTBOX_RECOVERY_REQUIRED" });
}

export async function replayIntegrationOutboxForActor(args: { user: AppUser; outboxId: string }) { return requireRecovery(args); }
export async function retryIntegrationOutboxNowForActor(args: { user: AppUser; outboxId: string }) { return requireRecovery(args); }
