import type { AppRole } from "@prisma/client";

export type LiveMapDriverStatus = "online" | "idle" | "stale" | "offline";

export type ManagerLiveMapDriver = {
  id: string;
  name: string;
  email: string;
  warehouseId: string | null;
  warehouseIds: string[];
  driverType: "local" | "linehaul";
  liveEnabled: boolean;
  lat: number;
  lng: number;
  headingDeg: number;
  speedKmh: number;
  lastSeenAt: string;
  status: LiveMapDriverStatus;
  region: string | null;
  activeOrderId: string | null;
  seed: number;
};

export type ManagerLiveMapOrder = {
  id: string;
  orderNumber: string | null;
  status: string | null;
  pickupLat: number | null;
  pickupLng: number | null;
  dropoffLat: number | null;
  dropoffLng: number | null;
  assignedDriverId: string | null;
  warehouseId: string | null;
  region: string | null;
};

export type ManagerLiveMapWarehouse = {
  id: string;
  name: string;
  location: string | null;
  region: string | null;
  type: string | null;
  lat: number | null;
  lng: number | null;
};

export type ManagerLiveMapSnapshot = {
  generatedAt: string;
  drivers: ManagerLiveMapDriver[];
  orders: ManagerLiveMapOrder[];
  warehouses: ManagerLiveMapWarehouse[];
  isMock: boolean;
};

export type DriverLocationRecord = {
  driverId: string;
  warehouseId: string | null;
  lat: number;
  lng: number;
  speedKmh: number;
  headingDeg: number;
  accuracyM: number | null;
  recordedAt: string;
  orderId: string | null;
};

export type DriverPresenceRecord = {
  driverId: string;
  enabled: boolean;
  heartbeatAt: string | null;
  updatedAt: string;
};

export type LiveMapEvent =
  | {
      type: "driver_location_upsert";
      at: string;
      payload: DriverLocationRecord & {
        status?: LiveMapDriverStatus;
        liveEnabled?: boolean;
        heartbeatAt?: string | null;
      };
    }
  | {
      type: "driver_presence_update";
      at: string;
      payload: DriverPresenceRecord;
    }
  | {
      type: "driver_presence_heartbeat";
      at: string;
      payload: {
        driverId: string;
        heartbeatAt: string;
      };
    };

export type LiveMapActor = {
  role: AppRole;
  warehouseId: string | null;
};
