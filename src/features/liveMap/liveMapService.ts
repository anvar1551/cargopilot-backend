import { AppRole, DriverType, OrderStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "../../config/prismaClient";
import {
  publishLiveMapEvent,
  readDriverLocation,
  readDriverLocations,
  readDriverPresences,
  touchDriverPresenceHeartbeat,
  upsertDriverLocation,
  upsertDriverPresence,
} from "./liveMapStore";
import type {
  DriverLocationRecord,
  DriverPresenceRecord,
  LiveMapActor,
  LiveMapDriverStatus,
  LiveMapViewport,
  ManagerLiveMapDriver,
  ManagerLiveMapOrder,
  ManagerLiveMapSnapshot,
  ManagerLiveMapWarehouse,
} from "./liveMap.types";

const DEFAULT_CENTER = {
  lat: 41.2995,
  lng: 69.2401,
};

const DRIVER_STATUS_ONLINE_SEC = Math.min(
  Math.max(Number(process.env.LIVE_MAP_DRIVER_ONLINE_SEC || 70), 15),
  600,
);
const DRIVER_STATUS_IDLE_SEC = Math.max(
  DRIVER_STATUS_ONLINE_SEC,
  Math.min(Math.max(Number(process.env.LIVE_MAP_DRIVER_IDLE_SEC || 180), 30), 60 * 60),
);
const DRIVER_STATUS_STALE_SEC = Math.max(
  DRIVER_STATUS_IDLE_SEC,
  Math.min(Math.max(Number(process.env.LIVE_MAP_DRIVER_STALE_SEC || 600), 90), 60 * 60 * 24),
);
const LIVE_MAP_DELTA_MIN_DISTANCE_M = Math.max(
  1,
  Number(process.env.LIVE_MAP_DELTA_MIN_DISTANCE_M || 25),
);
const LIVE_MAP_DELTA_MAX_INTERVAL_SEC = Math.max(
  1,
  Number(process.env.LIVE_MAP_DELTA_MAX_INTERVAL_SEC || 10),
);
const DRIVER_PROFILE_CACHE_TTL_MS = Math.min(
  Math.max(Number(process.env.LIVE_MAP_DRIVER_PROFILE_CACHE_TTL_MS || 60_000), 5_000),
  10 * 60_000,
);

function readIntEnv(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

type DriverProfile = {
  id: string;
  role: AppRole;
  warehouseId: string | null;
  liveLocationEnabled: boolean;
  liveLocationUpdatedAt: Date;
};

const driverProfileCache = new Map<string, { expiresAt: number; profile: DriverProfile }>();
const driverProfileCacheGcTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of driverProfileCache.entries()) {
    if (now >= entry.expiresAt) driverProfileCache.delete(key);
  }
}, 60_000);
driverProfileCacheGcTimer.unref();

function readCachedDriverProfile(driverId: string) {
  const hit = driverProfileCache.get(driverId);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAt) {
    driverProfileCache.delete(driverId);
    return null;
  }
  return hit.profile;
}

function writeCachedDriverProfile(profile: DriverProfile) {
  driverProfileCache.set(profile.id, {
    profile,
    expiresAt: Date.now() + DRIVER_PROFILE_CACHE_TTL_MS,
  });
}

async function getDriverProfile(driverId: string) {
  const cached = readCachedDriverProfile(driverId);
  if (cached) return cached;

  const profile = await prisma.user.findUnique({
    where: { id: driverId },
    select: {
      id: true,
      role: true,
      warehouseId: true,
      liveLocationEnabled: true,
      liveLocationUpdatedAt: true,
    },
  });
  if (!profile) return null;
  writeCachedDriverProfile(profile);
  return profile;
}

const liveMapOrderStatuses: OrderStatus[] = [
  OrderStatus.pending,
  OrderStatus.assigned,
  OrderStatus.pickup_in_progress,
  OrderStatus.picked_up,
  OrderStatus.at_warehouse,
  OrderStatus.in_transit,
  OrderStatus.out_for_delivery,
  OrderStatus.exception,
  OrderStatus.return_in_progress,
];

const driverLocationSchema = z.object({
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  speedKmh: z.number().min(0).max(220).optional(),
  headingDeg: z.number().min(0).max(360).optional(),
  accuracyM: z.number().min(0).max(5000).optional(),
  recordedAt: z.string().datetime().optional(),
  orderId: z.string().uuid().optional(),
  driverId: z.string().uuid().optional(),
});

const driverPresenceUpdateSchema = z.object({
  enabled: z.boolean(),
  driverId: z.string().uuid().optional(),
});

const driverPresenceHeartbeatSchema = z.object({
  recordedAt: z.string().datetime().optional(),
  driverId: z.string().uuid().optional(),
});

const driverPresenceQuerySchema = z.object({
  driverId: z.string().uuid().optional(),
});

function hashString(input: string) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function toLatitude(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= -90 && value <= 90 ? value : null;
}

function toLongitude(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= -180 && value <= 180 ? value : null;
}

function parseIsoTs(value: string | null | undefined) {
  if (!value) return Number.NaN;
  return new Date(value).getTime();
}

function pickLatestIso(values: Array<string | null | undefined>) {
  let picked: string | null = null;
  let pickedTs = Number.NEGATIVE_INFINITY;

  for (const value of values) {
    const ts = parseIsoTs(value);
    if (!Number.isFinite(ts)) continue;
    if (ts > pickedTs) {
      pickedTs = ts;
      picked = value ?? null;
    }
  }

  return picked;
}

function deriveDriverStatus(lastSeenAtIso: string | null | undefined, liveEnabled = true): LiveMapDriverStatus {
  if (!liveEnabled) return "offline";

  const ts = parseIsoTs(lastSeenAtIso);
  if (!Number.isFinite(ts)) return "offline";

  const ageSec = Math.max(0, (Date.now() - ts) / 1000);
  if (ageSec <= DRIVER_STATUS_ONLINE_SEC) return "online";
  if (ageSec <= DRIVER_STATUS_IDLE_SEC) return "idle";
  if (ageSec <= DRIVER_STATUS_STALE_SEC) return "stale";
  return "offline";
}

function isInViewport(lat: number, lng: number, viewport?: LiveMapViewport | null) {
  if (!viewport) return true;
  return (
    lat >= viewport.minLat &&
    lat <= viewport.maxLat &&
    lng >= viewport.minLng &&
    lng <= viewport.maxLng
  );
}

function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number) {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const earthRadiusM = 6371000;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * earthRadiusM * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function shouldBroadcastLocationDelta(args: {
  previous: DriverLocationRecord | null;
  current: DriverLocationRecord;
}) {
  const { previous, current } = args;
  if (!previous) return true;
  if (previous.orderId !== current.orderId) return true;
  if (previous.warehouseId !== current.warehouseId) return true;

  const prevTs = new Date(previous.recordedAt).getTime();
  const nextTs = new Date(current.recordedAt).getTime();
  const elapsedSec =
    Number.isFinite(prevTs) && Number.isFinite(nextTs)
      ? Math.max(0, (nextTs - prevTs) / 1000)
      : LIVE_MAP_DELTA_MAX_INTERVAL_SEC;
  if (elapsedSec >= LIVE_MAP_DELTA_MAX_INTERVAL_SEC) return true;

  const movedMeters = haversineMeters(previous.lat, previous.lng, current.lat, current.lng);
  if (movedMeters >= LIVE_MAP_DELTA_MIN_DISTANCE_M) return true;

  return false;
}

function mapOrderRecord(order: {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  pickupLat: number | null;
  pickupLng: number | null;
  dropoffLat: number | null;
  dropoffLng: number | null;
  assignedDriverId: string | null;
  currentWarehouseId: string | null;
  currentWarehouse: { region: string | null } | null;
}): ManagerLiveMapOrder {
  return {
    id: order.id,
    orderNumber: order.orderNumber ?? null,
    status: order.status ?? null,
    pickupLat: toLatitude(order.pickupLat),
    pickupLng: toLongitude(order.pickupLng),
    dropoffLat: toLatitude(order.dropoffLat),
    dropoffLng: toLongitude(order.dropoffLng),
    assignedDriverId: order.assignedDriverId ?? null,
    warehouseId: order.currentWarehouseId ?? null,
    region: order.currentWarehouse?.region ?? null,
  };
}

function getOrderViewportWhere(viewport: LiveMapViewport | null): Prisma.OrderWhereInput {
  if (!viewport) return {};
  return {
    OR: [
      {
        pickupLat: { gte: viewport.minLat, lte: viewport.maxLat },
        pickupLng: { gte: viewport.minLng, lte: viewport.maxLng },
      },
      {
        dropoffLat: { gte: viewport.minLat, lte: viewport.maxLat },
        dropoffLng: { gte: viewport.minLng, lte: viewport.maxLng },
      },
    ],
  };
}

function getWarehouseViewportWhere(viewport: LiveMapViewport | null): Prisma.WarehouseWhereInput {
  if (!viewport) return {};
  return {
    latitude: { gte: viewport.minLat, lte: viewport.maxLat },
    longitude: { gte: viewport.minLng, lte: viewport.maxLng },
  };
}

function mergeLiveMapOrderRows<T extends { id: string; updatedAt: Date }>(
  batches: T[][],
  maxOrders: number,
) {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const batch of batches) {
    for (const row of batch) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(row);
    }
  }
  return merged
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, maxOrders);
}

function resolveTargetDriverId(args: {
  actor: LiveMapActor & { userId: string };
  requestedDriverId?: string;
}) {
  const { actor, requestedDriverId } = args;

  if (actor.role === AppRole.manager) {
    if (requestedDriverId) return requestedDriverId;
    throw new Error("driverId is required for manager action");
  }

  if (requestedDriverId && requestedDriverId !== actor.userId) {
    throw new Error("Driver cannot submit action for a different driver");
  }

  return actor.userId;
}

export async function getLiveMapSnapshot(args: {
  actor: LiveMapActor;
  viewport?: LiveMapViewport | null;
}): Promise<ManagerLiveMapSnapshot> {
  const actor = args.actor;
  const viewport = args.viewport ?? null;
  const maxOrders = readIntEnv("LIVE_MAP_SNAPSHOT_ORDER_LIMIT", 180, 20, 1000);
  const maxDrivers = readIntEnv("LIVE_MAP_SNAPSHOT_DRIVER_LIMIT", 180, 20, 500);
  const maxWarehouses = readIntEnv("LIVE_MAP_SNAPSHOT_WAREHOUSE_LIMIT", 250, 20, 1000);
  const recentHours = readIntEnv("LIVE_MAP_RECENT_HOURS", 24, 1, 24 * 14);
  const recentFrom = new Date(Date.now() - recentHours * 60 * 60 * 1000);

  const warehouseScope: Prisma.OrderWhereInput =
    actor.role === AppRole.warehouse
      ? actor.warehouseId
        ? { currentWarehouseId: actor.warehouseId }
        : { currentWarehouseId: "__warehouse_scope_no_access__" }
      : {};
  const driverScope: Prisma.UserWhereInput =
    actor.role === AppRole.warehouse
      ? actor.warehouseId
        ? {
            OR: [
              { driverType: DriverType.linehaul },
              { warehouseId: actor.warehouseId },
              { warehouseAccesses: { some: { warehouseId: actor.warehouseId } } },
            ],
          }
        : { id: "__warehouse_scope_no_access__" }
      : {};
  const warehouseListScope: Prisma.WarehouseWhereInput =
    actor.role === AppRole.warehouse
      ? actor.warehouseId
        ? { id: actor.warehouseId }
        : { id: "__warehouse_scope_no_access__" }
      : {};
  const orderViewportWhere = getOrderViewportWhere(viewport);
  const warehouseViewportWhere = getWarehouseViewportWhere(viewport);
  const orderSelect = {
    id: true,
    orderNumber: true,
    status: true,
    pickupLat: true,
    pickupLng: true,
    dropoffLat: true,
    dropoffLng: true,
    assignedDriverId: true,
    currentWarehouseId: true,
    updatedAt: true,
    currentWarehouse: {
      select: {
        region: true,
      },
    },
  } satisfies Prisma.OrderSelect;

  const [driverRows, activeOrderRows, recentOrderRows, warehouseRows] = await Promise.all([
    prisma.user.findMany({
      where: {
        role: AppRole.driver,
        ...driverScope,
      },
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
        warehouseId: true,
        driverType: true,
        liveLocationEnabled: true,
        liveLocationUpdatedAt: true,
        warehouseAccesses: {
          select: {
            warehouseId: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      take: maxDrivers,
    }),
    prisma.order.findMany({
      where: {
        AND: [
          warehouseScope,
          { status: { in: liveMapOrderStatuses } },
          orderViewportWhere,
        ],
      },
      select: orderSelect,
      orderBy: {
        updatedAt: "desc",
      },
      take: maxOrders,
    }),
    prisma.order.findMany({
      where: {
        AND: [warehouseScope, { updatedAt: { gte: recentFrom } }, orderViewportWhere],
      },
      select: orderSelect,
      orderBy: {
        updatedAt: "desc",
      },
      take: maxOrders,
    }),
    prisma.warehouse.findMany({
      where: {
        AND: [warehouseListScope, warehouseViewportWhere],
      },
      select: {
        id: true,
        name: true,
        location: true,
        region: true,
        type: true,
        latitude: true,
        longitude: true,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: maxWarehouses,
    }),
  ]);

  const orderRows = mergeLiveMapOrderRows([activeOrderRows, recentOrderRows], maxOrders);
  const orders = orderRows.map(mapOrderRecord);
  const orderByAssignedDriver = new Map<string, ManagerLiveMapOrder>();
  const orderCoords: Array<{ lat: number; lng: number }> = [];
  const warehouseSeed = new Map<string, { latSum: number; lngSum: number; count: number }>();
  for (const order of orders) {
    if (order.assignedDriverId && !orderByAssignedDriver.has(order.assignedDriverId)) {
      orderByAssignedDriver.set(order.assignedDriverId, order);
    }

    if (order.pickupLat != null && order.pickupLng != null) {
      orderCoords.push({ lat: order.pickupLat, lng: order.pickupLng });
      if (order.warehouseId) {
        const current = warehouseSeed.get(order.warehouseId) ?? {
          latSum: 0,
          lngSum: 0,
          count: 0,
        };
        current.latSum += order.pickupLat;
        current.lngSum += order.pickupLng;
        current.count += 1;
        warehouseSeed.set(order.warehouseId, current);
      }
    }
    if (order.dropoffLat != null && order.dropoffLng != null) {
      orderCoords.push({ lat: order.dropoffLat, lng: order.dropoffLng });
    }
  }

  const warehouses: ManagerLiveMapWarehouse[] = warehouseRows.map((row) => {
    const seed = warehouseSeed.get(row.id);
    return {
      id: row.id,
      name: row.name,
      location: row.location ?? null,
      region: row.region ?? null,
      type: row.type ?? null,
      lat: toLatitude(row.latitude) ?? (seed && seed.count > 0 ? seed.latSum / seed.count : null),
      lng: toLongitude(row.longitude) ?? (seed && seed.count > 0 ? seed.lngSum / seed.count : null),
    };
  });
  const warehouseRegionById = new Map<string, string | null>(
    warehouses.map((warehouse) => [warehouse.id, warehouse.region ?? null]),
  );

  const driverIds = driverRows.map((driver) => driver.id);
  const [driverLocations, driverPresences] = await Promise.all([
    readDriverLocations(driverIds),
    readDriverPresences(driverIds),
  ]);

  const drivers: ManagerLiveMapDriver[] = driverRows.map((driver) => {
    const seed = hashString(driver.id);
    const assignedOrder = orderByAssignedDriver.get(driver.id) ?? null;
    const location = driverLocations.get(driver.id) ?? null;
    const presence = driverPresences.get(driver.id) ?? null;

    const warehouseIds = Array.from(
      new Set(
        [
          driver.warehouseId ?? null,
          ...driver.warehouseAccesses.map((link) => link.warehouseId),
        ].filter((value): value is string => Boolean(value)),
      ),
    );

    const fallbackAnchor =
      assignedOrder && assignedOrder.dropoffLat != null && assignedOrder.dropoffLng != null
        ? { lat: assignedOrder.dropoffLat, lng: assignedOrder.dropoffLng }
        : assignedOrder && assignedOrder.pickupLat != null && assignedOrder.pickupLng != null
          ? { lat: assignedOrder.pickupLat, lng: assignedOrder.pickupLng }
          : orderCoords.length > 0
            ? orderCoords[seed % orderCoords.length]
            : DEFAULT_CENTER;

    const liveEnabled = presence?.enabled ?? driver.liveLocationEnabled ?? true;
    const heartbeatAt = pickLatestIso([location?.recordedAt ?? null, presence?.heartbeatAt ?? null]);
    const status = deriveDriverStatus(heartbeatAt, liveEnabled);
    const lastSeenAt =
      heartbeatAt ??
      driver.liveLocationUpdatedAt?.toISOString() ??
      driver.createdAt.toISOString();

    return {
      id: driver.id,
      name: driver.name,
      email: driver.email,
      warehouseId: driver.warehouseId ?? null,
      liveEnabled,
      lat: location?.lat ?? fallbackAnchor.lat,
      lng: location?.lng ?? fallbackAnchor.lng,
      headingDeg: Math.round(location?.headingDeg ?? (seed % 360)),
      speedKmh: Math.round(location?.speedKmh ?? 0),
      lastSeenAt,
      status,
      region:
        (driver.warehouseId ? (warehouseRegionById.get(driver.warehouseId) ?? null) : null) ??
        (warehouseIds.length > 0
          ? (warehouseRegionById.get(warehouseIds[0]) ?? null)
          : null),
      warehouseIds,
      driverType: driver.driverType === DriverType.linehaul ? "linehaul" : "local",
      activeOrderId: location?.orderId ?? assignedOrder?.id ?? null,
      seed,
    };
  });

  const viewportFilteredOrders = viewport
    ? orders.filter((order) => {
        const pickupVisible =
          order.pickupLat != null &&
          order.pickupLng != null &&
          isInViewport(order.pickupLat, order.pickupLng, viewport);
        const dropoffVisible =
          order.dropoffLat != null &&
          order.dropoffLng != null &&
          isInViewport(order.dropoffLat, order.dropoffLng, viewport);
        return pickupVisible || dropoffVisible;
      })
    : orders;

  const viewportFilteredDrivers = viewport
    ? drivers.filter((driver) => isInViewport(driver.lat, driver.lng, viewport))
    : drivers;

  const viewportFilteredWarehouses = viewport
    ? warehouses.filter(
        (warehouse) =>
          warehouse.lat != null &&
          warehouse.lng != null &&
          isInViewport(warehouse.lat, warehouse.lng, viewport),
      )
    : warehouses;

  return {
    generatedAt: new Date().toISOString(),
    drivers: viewportFilteredDrivers,
    orders: viewportFilteredOrders,
    warehouses: viewportFilteredWarehouses,
    isMock: false,
  };
}

export async function ingestDriverLocation(args: {
  actor: LiveMapActor & { userId: string };
  body: unknown;
}) {
  const parsed = driverLocationSchema.parse(args.body);
  const role = args.actor.role;

  let targetDriverId = args.actor.userId;
  if (role === AppRole.manager && parsed.driverId) {
    targetDriverId = parsed.driverId;
  }
  if (role !== AppRole.manager && parsed.driverId && parsed.driverId !== args.actor.userId) {
    throw new Error("Driver cannot submit location for a different driver");
  }

  const recordedAt = parsed.recordedAt ? new Date(parsed.recordedAt) : new Date();
  if (Number.isNaN(recordedAt.getTime())) {
    throw new Error("Invalid recordedAt timestamp");
  }

  const targetDriver = await getDriverProfile(targetDriverId);
  if (!targetDriver || targetDriver.role !== AppRole.driver) {
    throw new Error("Target driver not found");
  }

  const previousLocation = await readDriverLocation(targetDriver.id);
  const location: DriverLocationRecord = {
    driverId: targetDriver.id,
    warehouseId: targetDriver.warehouseId ?? null,
    lat: parsed.lat,
    lng: parsed.lng,
    speedKmh: parsed.speedKmh ?? 0,
    headingDeg: parsed.headingDeg ?? 0,
    accuracyM: parsed.accuracyM ?? null,
    recordedAt: recordedAt.toISOString(),
    orderId: parsed.orderId ?? null,
  };

  await upsertDriverLocation(location);
  const presence = await touchDriverPresenceHeartbeat({
    driverId: targetDriver.id,
    heartbeatAt: location.recordedAt,
  });
  const status = deriveDriverStatus(presence.heartbeatAt ?? location.recordedAt, targetDriver.liveLocationEnabled);

  const shouldBroadcast = shouldBroadcastLocationDelta({
    previous: previousLocation,
    current: location,
  });

  if (shouldBroadcast) {
    await publishLiveMapEvent({
      type: "driver_location_upsert",
      at: new Date().toISOString(),
      payload: {
        ...location,
        status,
        liveEnabled: targetDriver.liveLocationEnabled,
        heartbeatAt: presence.heartbeatAt,
        seq: Date.now(),
      },
    });
  }

  return {
    ok: true,
    location,
    status,
    liveEnabled: targetDriver.liveLocationEnabled,
    broadcasted: shouldBroadcast,
  };
}

export async function getDriverPresence(args: {
  actor: LiveMapActor & { userId: string };
  query: unknown;
}) {
  const parsedQuery = driverPresenceQuerySchema.parse(args.query ?? {});
  const targetDriverId = resolveTargetDriverId({
    actor: args.actor,
    requestedDriverId: parsedQuery.driverId,
  });

  const targetDriver = await getDriverProfile(targetDriverId);
  if (!targetDriver || targetDriver.role !== AppRole.driver) {
    throw new Error("Target driver not found");
  }

  const presences = await readDriverPresences([targetDriver.id]);
  const presence = presences.get(targetDriver.id) ?? null;
  const heartbeatAt = pickLatestIso([presence?.heartbeatAt ?? null]);
  const enabled = targetDriver.liveLocationEnabled;

  return {
    ok: true,
    presence: {
      driverId: targetDriver.id,
      enabled,
      heartbeatAt,
      updatedAt: targetDriver.liveLocationUpdatedAt.toISOString(),
    } satisfies DriverPresenceRecord,
    status: deriveDriverStatus(heartbeatAt, enabled),
  };
}

export async function setDriverPresence(args: {
  actor: LiveMapActor & { userId: string };
  body: unknown;
}) {
  const parsed = driverPresenceUpdateSchema.parse(args.body);
  const targetDriverId = resolveTargetDriverId({
    actor: args.actor,
    requestedDriverId: parsed.driverId,
  });

  const targetDriver = await getDriverProfile(targetDriverId);
  if (!targetDriver || targetDriver.role !== AppRole.driver) {
    throw new Error("Target driver not found");
  }

  const now = new Date();
  const updatedDriver = await prisma.user.update({
    where: { id: targetDriver.id },
    data: {
      liveLocationEnabled: parsed.enabled,
      liveLocationUpdatedAt: now,
    },
    select: {
      id: true,
      role: true,
      warehouseId: true,
      liveLocationEnabled: true,
      liveLocationUpdatedAt: true,
    },
  });
  writeCachedDriverProfile(updatedDriver);

  const presences = await readDriverPresences([updatedDriver.id]);
  const currentPresence = presences.get(updatedDriver.id) ?? null;

  const nextPresence: DriverPresenceRecord = {
    driverId: updatedDriver.id,
    enabled: updatedDriver.liveLocationEnabled,
    heartbeatAt: currentPresence?.heartbeatAt ?? null,
    updatedAt: updatedDriver.liveLocationUpdatedAt.toISOString(),
  };

  await upsertDriverPresence(nextPresence);
  const status = deriveDriverStatus(nextPresence.heartbeatAt, nextPresence.enabled);

  await publishLiveMapEvent({
    type: "driver_presence_update",
    at: now.toISOString(),
    payload: nextPresence,
  });

  return {
    ok: true,
    presence: nextPresence,
    status,
  };
}

export async function heartbeatDriverPresence(args: {
  actor: LiveMapActor & { userId: string };
  body: unknown;
}) {
  const parsed = driverPresenceHeartbeatSchema.parse(args.body);
  const targetDriverId = resolveTargetDriverId({
    actor: args.actor,
    requestedDriverId: parsed.driverId,
  });

  const targetDriver = await getDriverProfile(targetDriverId);
  if (!targetDriver || targetDriver.role !== AppRole.driver) {
    throw new Error("Target driver not found");
  }

  const heartbeatAt = parsed.recordedAt
    ? new Date(parsed.recordedAt).toISOString()
    : new Date().toISOString();

  const touched = await touchDriverPresenceHeartbeat({
    driverId: targetDriver.id,
    heartbeatAt,
  });

  const nextPresence: DriverPresenceRecord = {
    ...touched,
    enabled: targetDriver.liveLocationEnabled,
  };
  await upsertDriverPresence(nextPresence);

  const status = deriveDriverStatus(nextPresence.heartbeatAt, nextPresence.enabled);

  await publishLiveMapEvent({
    type: "driver_presence_heartbeat",
    at: heartbeatAt,
    payload: {
      driverId: targetDriver.id,
      heartbeatAt,
    },
  });

  return {
    ok: true,
    presence: nextPresence,
    status,
  };
}
