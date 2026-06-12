"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processIntegrationCanonicalEventsOnce = processIntegrationCanonicalEventsOnce;
const carrier_events_1 = require("../../orders-legs/carrier-events");
const canonical_event_repo_1 = require("../infrastructure/canonical-event.repo");
function errorMessage(error) {
    const candidate = error;
    return String(candidate?.message || error || "canonical event processing failed");
}
async function processOne(event) {
    if (event.domain === "carrier") {
        const result = await (0, carrier_events_1.applyCarrierIntegrationEvent)(event);
        if (result.applied) {
            await canonical_event_repo_1.integrationCanonicalEventRepository.markProcessed(event.id);
            return "processed";
        }
        const reason = "reason" in result ? result.reason : "carrier event was not applied";
        await canonical_event_repo_1.integrationCanonicalEventRepository.markIgnored(event.id, reason);
        return "ignored";
    }
    await canonical_event_repo_1.integrationCanonicalEventRepository.markIgnored(event.id, `No canonical processor for domain '${event.domain}'`);
    return "ignored";
}
async function processIntegrationCanonicalEventsOnce(args) {
    const staleProcessingBeforeIso = args?.staleProcessingBeforeIso ?? new Date(Date.now() - 5 * 60000).toISOString();
    const batch = await canonical_event_repo_1.integrationCanonicalEventRepository.claimBatch({
        limit: args?.limit ?? 25,
        staleProcessingBeforeIso,
    });
    const result = {
        claimed: batch.length,
        processed: 0,
        ignored: 0,
        failed: 0,
    };
    for (const event of batch) {
        try {
            const outcome = await processOne(event);
            result[outcome] += 1;
        }
        catch (error) {
            result.failed += 1;
            await canonical_event_repo_1.integrationCanonicalEventRepository.markFailed(event.id, errorMessage(error));
        }
    }
    return result;
}
