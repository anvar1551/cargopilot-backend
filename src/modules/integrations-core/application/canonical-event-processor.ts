import { applyCarrierIntegrationEvent } from "../../orders-legs/carrier-events";
import { integrationCanonicalEventRepository } from "../infrastructure/canonical-event.repo";

export type ProcessIntegrationCanonicalEventsResult = {
  claimed: number;
  processed: number;
  ignored: number;
  failed: number;
};

function errorMessage(error: unknown) {
  const candidate = error as { message?: string };
  return String(candidate?.message || error || "canonical event processing failed");
}

async function processOne(event: Awaited<ReturnType<typeof integrationCanonicalEventRepository.claimBatch>>[number]) {
  if (event.domain === "carrier") {
    const result = await applyCarrierIntegrationEvent(event);
    if (result.applied) {
      await integrationCanonicalEventRepository.markProcessed(event.id);
      return "processed" as const;
    }
    const reason = "reason" in result ? result.reason : "carrier event was not applied";
    await integrationCanonicalEventRepository.markIgnored(event.id, reason);
    return "ignored" as const;
  }

  await integrationCanonicalEventRepository.markIgnored(
    event.id,
    `No canonical processor for domain '${event.domain}'`,
  );
  return "ignored" as const;
}

export async function processIntegrationCanonicalEventsOnce(args?: {
  limit?: number;
  staleProcessingBeforeIso?: string | null;
}): Promise<ProcessIntegrationCanonicalEventsResult> {
  const staleProcessingBeforeIso =
    args?.staleProcessingBeforeIso ?? new Date(Date.now() - 5 * 60_000).toISOString();
  const batch = await integrationCanonicalEventRepository.claimBatch({
    limit: args?.limit ?? 25,
    staleProcessingBeforeIso,
  });

  const result: ProcessIntegrationCanonicalEventsResult = {
    claimed: batch.length,
    processed: 0,
    ignored: 0,
    failed: 0,
  };

  for (const event of batch) {
    try {
      const outcome = await processOne(event);
      result[outcome] += 1;
    } catch (error) {
      result.failed += 1;
      await integrationCanonicalEventRepository.markFailed(event.id, errorMessage(error));
    }
  }

  return result;
}
