import type { AppUser } from "../../src/types/app-user";
const actor={id:"synthetic"} as AppUser;
import { FinanceSubledgerService } from "../../src/modules/finance-core/application/finance-subledger.service";
import type { FinanceSubledgerRepositoryPort } from "../../src/modules/finance-core/application/finance-subledger.port";

describe("FinanceSubledgerService", () => {
  const repository: jest.Mocked<FinanceSubledgerRepositoryPort> = {
    getReceivablesAging: jest.fn(),
    getPayablesAging: jest.fn(),
    listUnappliedCash: jest.fn(),
  };
  const service = new FinanceSubledgerService(repository);

  beforeEach(() => jest.clearAllMocks());

  it("normalizes a receivables currency before repository access", async () => {
    repository.getReceivablesAging.mockResolvedValue({ items: [] });
    await service.getReceivablesAging(actor, {
      asOf: new Date("2026-08-03T00:00:00.000Z"),
      limit: 50,
      currency: "usd",
    });
    expect(repository.getReceivablesAging).toHaveBeenCalledWith(actor, expect.objectContaining({
      currency: "USD",
    }));
  });

  it("rejects an invalid aging date before repository access", () => {
    expect(() => service.getPayablesAging(actor, {
      asOf: new Date("invalid"),
      limit: 50,
    })).toThrow(expect.objectContaining({ code: "FINANCE_AGING_DATE_INVALID" }));
    expect(repository.getPayablesAging).not.toHaveBeenCalled();
  });

  it("normalizes unapplied cash currency", async () => {
    repository.listUnappliedCash.mockResolvedValue({ items: [] });
    await service.listUnappliedCash(actor, { limit: 50, currency: "cny" });
    expect(repository.listUnappliedCash).toHaveBeenCalledWith(actor, expect.objectContaining({
      currency: "CNY",
    }));
  });
});
