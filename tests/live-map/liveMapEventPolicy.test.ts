import { canDeliverLiveMapEvent } from "../../src/modules/live-map-core/application/liveMapEventPolicy";
import type {
  DriverLocationRecord,
  LiveMapActor,
  LiveMapEvent,
  LiveMapViewport,
} from "../../src/modules/live-map-core/application/liveMap.types";

const tashkentViewport: LiveMapViewport = {
  minLat: 41.1,
  minLng: 68.85,
  maxLat: 41.5,
  maxLng: 69.65,
};

function locationEvent(overrides: Partial<DriverLocationRecord> = {}): LiveMapEvent {
  return {
    type: "driver_location_upsert",
    at: "2026-08-02T12:00:00.000Z",
    payload: {
      driverId: "0198c72f-1800-7000-8000-000000000001",
      warehouseId: "0198c72f-1800-7000-8000-000000000002",
      lat: 53.5511,
      lng: 9.9937,
      speedKmh: 0,
      headingDeg: 0,
      accuracyM: 10,
      recordedAt: "2026-08-02T12:00:00.000Z",
      orderId: null,
      ...overrides,
    },
  };
}

const manager: LiveMapActor = {
  userId: "0198c72f-1800-7000-8000-000000000010",
  warehouseId: null,
  roleCodes: [],
  permissionCodes: ["shipment.view", "drivers.manage"],
};

const warehouseActor: LiveMapActor = {
  userId: "0198c72f-1800-7000-8000-000000000011",
  warehouseId: "0198c72f-1800-7000-8000-000000000002",
  roleCodes: [],
  permissionCodes: ["shipment.view"],
};

describe("live-map event policy", () => {
  it("allows managers to discover drivers outside the current viewport", () => {
    expect(
      canDeliverLiveMapEvent({ actor: manager, event: locationEvent(), viewport: tashkentViewport }),
    ).toBe(true);
  });

  it("keeps warehouse streams constrained to their viewport", () => {
    expect(
      canDeliverLiveMapEvent({
        actor: warehouseActor,
        event: locationEvent(),
        viewport: tashkentViewport,
      }),
    ).toBe(false);
  });

  it("rejects another warehouse's driver event", () => {
    expect(
      canDeliverLiveMapEvent({
        actor: warehouseActor,
        event: locationEvent({
          lat: 41.2995,
          lng: 69.2401,
          warehouseId: "0198c72f-1800-7000-8000-000000000099",
        }),
        viewport: tashkentViewport,
      }),
    ).toBe(false);
  });
});
