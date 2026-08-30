import {
  agingBucket,
  allocationAmount,
  openItemStatus,
} from "../../src/modules/finance-core/domain/subledger";

describe("finance subledger", () => {
  it("classifies open-item balances without floating point arithmetic", () => {
    expect(openItemStatus("100", "100")).toBe("open");
    expect(openItemStatus("100", "25.2500")).toBe("partial");
    expect(openItemStatus("100", "0")).toBe("settled");
  });

  it("caps allocations at the smaller available balance", () => {
    expect(allocationAmount("125.1234", "40.0000")).toBe("40.0000");
    expect(allocationAmount("18", "40")).toBe("18.0000");
  });

  it("uses stable UTC calendar-day aging buckets", () => {
    const asOf = new Date("2026-08-03T23:30:00.000Z");
    expect(agingBucket(asOf, new Date("2026-08-03T00:00:00.000Z"))).toBe("current");
    expect(agingBucket(asOf, new Date("2026-08-02T00:00:00.000Z"))).toBe("days1To30");
    expect(agingBucket(asOf, new Date("2026-07-04T00:00:00.000Z"))).toBe("days1To30");
    expect(agingBucket(asOf, new Date("2026-07-03T00:00:00.000Z"))).toBe("days31To60");
    expect(agingBucket(asOf, new Date("2026-05-05T00:00:00.000Z"))).toBe("days61To90");
    expect(agingBucket(asOf, new Date("2026-05-04T00:00:00.000Z"))).toBe("daysOver90");
  });
});
