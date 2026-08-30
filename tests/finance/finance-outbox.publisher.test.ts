const queryRaw = jest.fn();
const updateMany = jest.fn();
const xadd = jest.fn();

jest.mock("../../src/config/prismaClient", () => ({
  __esModule: true,
  default: {
    $queryRaw: queryRaw,
    financeDomainEventOutbox: { updateMany },
  },
}));

jest.mock("../../src/config/redis", () => ({
  getRedisPrefix: () => "test",
  getRedisClient: jest.fn(async () => ({ xadd })),
  withRedisTimeout: jest.fn(async (_name: string, operation: () => Promise<unknown>) => operation()),
}));

import { processFinanceOutboxBatchOnce } from "../../src/modules/finance-core/infrastructure/finance-outbox.publisher";

const event = {
  id: "00000000-0000-7000-8000-000000000001",
  eventId: "00000000-0000-7000-8000-000000000002",
  legalEntityId: "00000000-0000-7000-8000-000000000003",
  aggregateType: "finance_journal",
  aggregateId: "00000000-0000-7000-8000-000000000004",
  eventType: "finance.journal.posted",
  schemaVersion: 1,
  occurredAt: new Date("2026-08-02T12:00:00.000Z"),
  payloadJson: { journalNumber: "GJ-00000001" },
  attempts: 0,
};

describe("finance outbox publisher", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updateMany.mockResolvedValue({ count: 1 });
  });

  it("publishes a claimed event and marks it complete", async () => {
    queryRaw.mockResolvedValue([event]);
    xadd.mockResolvedValue("1-0");

    await expect(
      processFinanceOutboxBatchOnce({ batchSize: 10, consumerId: "test-consumer" }),
    ).resolves.toEqual({ claimed: 1, published: 1, failed: 0 });

    expect(xadd.mock.calls[0]).toEqual(
      expect.arrayContaining([
        "test:cp:finance:events",
        "MAXLEN",
        "~",
        "100000",
        "finance.journal.posted",
      ]),
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: event.id, claimedBy: "test-consumer", publishedAt: null },
        data: expect.objectContaining({ publishedAt: expect.any(Date), lastError: null }),
      }),
    );
  });

  it("releases a failed claim for delayed retry", async () => {
    queryRaw.mockResolvedValue([event]);
    xadd.mockRejectedValue(new Error("redis down"));

    await expect(
      processFinanceOutboxBatchOnce({ batchSize: 10, consumerId: "test-consumer" }),
    ).resolves.toEqual({ claimed: 1, published: 0, failed: 1 });

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          claimedAt: null,
          claimedBy: null,
          nextAttemptAt: expect.any(Date),
          lastError: "redis down",
        }),
      }),
    );
  });
});
