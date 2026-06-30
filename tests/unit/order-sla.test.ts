const prismaMock = {
  pricingRegion: {
    findMany: jest.fn(),
  },
  zoneMatrixEntry: {
    findUnique: jest.fn(),
  },
  deliverySlaRule: {
    findMany: jest.fn(),
  },
};

jest.mock("../../src/config/prismaClient", () => ({
  __esModule: true,
  default: prismaMock,
}));

import { OrderSlaSource, ServiceType } from "@prisma/client";
import { resolveOrderSlaSnapshot } from "../../src/modules/orders-core/sla/resolve-order-sla";

describe("resolveOrderSlaSnapshot", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses an explicit promise date before pricing SLA rules", async () => {
    const promiseDate = new Date("2026-02-10T09:00:00.000Z");

    const snapshot = await resolveOrderSlaSnapshot({
      serviceType: ServiceType.DOOR_TO_DOOR,
      originQuery: "Beijing",
      destinationQuery: "Tashkent",
      promiseDate,
      createdAt: new Date("2026-02-01T09:00:00.000Z"),
    });

    expect(snapshot).toEqual({
      expectedDeliveryAt: promiseDate,
      slaSource: OrderSlaSource.PROMISE_DATE,
      slaRuleId: null,
      slaTargetDays: null,
    });
    expect(prismaMock.pricingRegion.findMany).not.toHaveBeenCalled();
    expect(prismaMock.deliverySlaRule.findMany).not.toHaveBeenCalled();
  });

  it("prefers exact route SLA over zone and service default SLA", async () => {
    const createdAt = new Date("2026-02-01T09:00:00.000Z");
    prismaMock.pricingRegion.findMany.mockResolvedValue([
      { id: "region_cn", code: "CN", name: "China", aliases: ["Beijing"] },
      { id: "region_uz", code: "UZ", name: "Uzbekistan", aliases: ["Tashkent"] },
    ]);
    prismaMock.zoneMatrixEntry.findUnique.mockResolvedValue({ zone: 8 });
    prismaMock.deliverySlaRule.findMany.mockResolvedValue([
      {
        id: "default_rule",
        originRegionId: null,
        destinationRegionId: null,
        zone: null,
        priority: 999,
        deliveryDays: 10,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: "zone_rule",
        originRegionId: null,
        destinationRegionId: null,
        zone: 8,
        priority: 100,
        deliveryDays: 7,
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      },
      {
        id: "exact_rule",
        originRegionId: "region_cn",
        destinationRegionId: "region_uz",
        zone: null,
        priority: 1,
        deliveryDays: 3,
        createdAt: new Date("2026-01-03T00:00:00.000Z"),
      },
    ]);

    const snapshot = await resolveOrderSlaSnapshot({
      serviceType: ServiceType.DOOR_TO_DOOR,
      originQuery: "Beijing",
      destinationQuery: "Tashkent",
      createdAt,
    });

    expect(snapshot.slaSource).toBe(OrderSlaSource.SLA_RULE);
    expect(snapshot.slaRuleId).toBe("exact_rule");
    expect(snapshot.slaTargetDays).toBe(3);
    expect(snapshot.expectedDeliveryAt?.toISOString()).toBe("2026-02-04T09:00:00.000Z");
  });

  it("uses zone SLA when no exact route rule is available", async () => {
    prismaMock.pricingRegion.findMany.mockResolvedValue([
      { id: "region_cn", code: "CN", name: "China", aliases: ["Beijing"] },
      { id: "region_uz", code: "UZ", name: "Uzbekistan", aliases: ["Tashkent"] },
    ]);
    prismaMock.zoneMatrixEntry.findUnique.mockResolvedValue({ zone: 8 });
    prismaMock.deliverySlaRule.findMany.mockResolvedValue([
      {
        id: "default_rule",
        originRegionId: null,
        destinationRegionId: null,
        zone: null,
        priority: 999,
        deliveryDays: 10,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: "zone_rule",
        originRegionId: null,
        destinationRegionId: null,
        zone: 8,
        priority: 100,
        deliveryDays: 7,
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    ]);

    const snapshot = await resolveOrderSlaSnapshot({
      serviceType: ServiceType.DOOR_TO_DOOR,
      originQuery: "Beijing",
      destinationQuery: "Tashkent",
      createdAt: new Date("2026-02-01T09:00:00.000Z"),
    });

    expect(snapshot.slaSource).toBe(OrderSlaSource.SLA_RULE);
    expect(snapshot.slaRuleId).toBe("zone_rule");
    expect(snapshot.slaTargetDays).toBe(7);
  });
});
