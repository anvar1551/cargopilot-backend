"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLiveMapSnapshot = getLiveMapSnapshot;
exports.ingestDriverLocation = ingestDriverLocation;
exports.getDriverPresence = getDriverPresence;
exports.setDriverPresence = setDriverPresence;
exports.heartbeatDriverPresence = heartbeatDriverPresence;
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const liveMapStore_1 = require("./liveMapStore");
const DEFAULT_CENTER = {
    lat: 41.2995,
    lng: 69.2401,
};
const DRIVER_STATUS_ONLINE_SEC = Math.min(Math.max(Number(process.env.LIVE_MAP_DRIVER_ONLINE_SEC || 70), 15), 600);
const DRIVER_STATUS_IDLE_SEC = Math.max(DRIVER_STATUS_ONLINE_SEC, Math.min(Math.max(Number(process.env.LIVE_MAP_DRIVER_IDLE_SEC || 180), 30), 60 * 60));
const DRIVER_STATUS_STALE_SEC = Math.max(DRIVER_STATUS_IDLE_SEC, Math.min(Math.max(Number(process.env.LIVE_MAP_DRIVER_STALE_SEC || 600), 90), 60 * 60 * 24));
const liveMapOrderStatuses = [
    client_1.OrderStatus.pending,
    client_1.OrderStatus.assigned,
    client_1.OrderStatus.pickup_in_progress,
    client_1.OrderStatus.picked_up,
    client_1.OrderStatus.at_warehouse,
    client_1.OrderStatus.in_transit,
    client_1.OrderStatus.out_for_delivery,
    client_1.OrderStatus.exception,
    client_1.OrderStatus.return_in_progress,
];
const driverLocationSchema = zod_1.z.object({
    lat: zod_1.z.number().gte(-90).lte(90),
    lng: zod_1.z.number().gte(-180).lte(180),
    speedKmh: zod_1.z.number().min(0).max(220).optional(),
    headingDeg: zod_1.z.number().min(0).max(360).optional(),
    accuracyM: zod_1.z.number().min(0).max(5000).optional(),
    recordedAt: zod_1.z.string().datetime().optional(),
    orderId: zod_1.z.string().uuid().optional(),
    driverId: zod_1.z.string().uuid().optional(),
});
const driverPresenceUpdateSchema = zod_1.z.object({
    enabled: zod_1.z.boolean(),
    driverId: zod_1.z.string().uuid().optional(),
});
const driverPresenceHeartbeatSchema = zod_1.z.object({
    recordedAt: zod_1.z.string().datetime().optional(),
    driverId: zod_1.z.string().uuid().optional(),
});
const driverPresenceQuerySchema = zod_1.z.object({
    driverId: zod_1.z.string().uuid().optional(),
});
function hashString(input) {
    let hash = 0;
    for (let i = 0; i < input.length; i += 1) {
        hash = (hash << 5) - hash + input.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
}
function toLatitude(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= -90 && value <= 90 ? value : null;
}
function toLongitude(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= -180 && value <= 180 ? value : null;
}
function parseIsoTs(value) {
    if (!value)
        return Number.NaN;
    return new Date(value).getTime();
}
function pickLatestIso(values) {
    let picked = null;
    let pickedTs = Number.NEGATIVE_INFINITY;
    for (const value of values) {
        const ts = parseIsoTs(value);
        if (!Number.isFinite(ts))
            continue;
        if (ts > pickedTs) {
            pickedTs = ts;
            picked = value ?? null;
        }
    }
    return picked;
}
function deriveDriverStatus(lastSeenAtIso, liveEnabled = true) {
    if (!liveEnabled)
        return "offline";
    const ts = parseIsoTs(lastSeenAtIso);
    if (!Number.isFinite(ts))
        return "offline";
    const ageSec = Math.max(0, (Date.now() - ts) / 1000);
    if (ageSec <= DRIVER_STATUS_ONLINE_SEC)
        return "online";
    if (ageSec <= DRIVER_STATUS_IDLE_SEC)
        return "idle";
    if (ageSec <= DRIVER_STATUS_STALE_SEC)
        return "stale";
    return "offline";
}
function mapOrderRecord(order) {
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
function resolveTargetDriverId(args) {
    const { actor, requestedDriverId } = args;
    if (actor.role === client_1.AppRole.manager) {
        if (requestedDriverId)
            return requestedDriverId;
        throw new Error("driverId is required for manager action");
    }
    if (requestedDriverId && requestedDriverId !== actor.userId) {
        throw new Error("Driver cannot submit action for a different driver");
    }
    return actor.userId;
}
async function getLiveMapSnapshot(actor) {
    const maxOrders = Math.min(Math.max(Number(process.env.LIVE_MAP_SNAPSHOT_ORDER_LIMIT || 300), 20), 1000);
    const recentHours = Math.min(Math.max(Number(process.env.LIVE_MAP_RECENT_HOURS || 72), 1), 24 * 14);
    const recentFrom = new Date(Date.now() - recentHours * 60 * 60 * 1000);
    const warehouseScope = actor.role === client_1.AppRole.warehouse
        ? actor.warehouseId
            ? { currentWarehouseId: actor.warehouseId }
            : { currentWarehouseId: "__warehouse_scope_no_access__" }
        : {};
    const driverScope = actor.role === client_1.AppRole.warehouse
        ? actor.warehouseId
            ? {
                OR: [
                    { driverType: client_1.DriverType.linehaul },
                    { warehouseId: actor.warehouseId },
                    { warehouseAccesses: { some: { warehouseId: actor.warehouseId } } },
                ],
            }
            : { id: "__warehouse_scope_no_access__" }
        : {};
    const warehouseListScope = actor.role === client_1.AppRole.warehouse
        ? actor.warehouseId
            ? { id: actor.warehouseId }
            : { id: "__warehouse_scope_no_access__" }
        : {};
    const [driverRows, orderRows, warehouseRows] = await Promise.all([
        prismaClient_1.default.user.findMany({
            where: {
                role: client_1.AppRole.driver,
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
            take: 500,
        }),
        prismaClient_1.default.order.findMany({
            where: {
                ...warehouseScope,
                OR: [
                    {
                        status: {
                            in: liveMapOrderStatuses,
                        },
                    },
                    {
                        updatedAt: {
                            gte: recentFrom,
                        },
                    },
                ],
            },
            select: {
                id: true,
                orderNumber: true,
                status: true,
                pickupLat: true,
                pickupLng: true,
                dropoffLat: true,
                dropoffLng: true,
                assignedDriverId: true,
                currentWarehouseId: true,
                currentWarehouse: {
                    select: {
                        region: true,
                    },
                },
            },
            orderBy: {
                updatedAt: "desc",
            },
            take: maxOrders,
        }),
        prismaClient_1.default.warehouse.findMany({
            where: warehouseListScope,
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
        }),
    ]);
    const orders = orderRows.map(mapOrderRecord);
    const orderByAssignedDriver = new Map();
    const orderCoords = [];
    const warehouseSeed = new Map();
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
    const warehouses = warehouseRows.map((row) => {
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
    const warehouseRegionById = new Map(warehouses.map((warehouse) => [warehouse.id, warehouse.region ?? null]));
    const driverIds = driverRows.map((driver) => driver.id);
    const [driverLocations, driverPresences] = await Promise.all([
        (0, liveMapStore_1.readDriverLocations)(driverIds),
        (0, liveMapStore_1.readDriverPresences)(driverIds),
    ]);
    const drivers = driverRows.map((driver) => {
        const seed = hashString(driver.id);
        const assignedOrder = orderByAssignedDriver.get(driver.id) ?? null;
        const location = driverLocations.get(driver.id) ?? null;
        const presence = driverPresences.get(driver.id) ?? null;
        const warehouseIds = Array.from(new Set([
            driver.warehouseId ?? null,
            ...driver.warehouseAccesses.map((link) => link.warehouseId),
        ].filter((value) => Boolean(value))));
        const fallbackAnchor = assignedOrder && assignedOrder.dropoffLat != null && assignedOrder.dropoffLng != null
            ? { lat: assignedOrder.dropoffLat, lng: assignedOrder.dropoffLng }
            : assignedOrder && assignedOrder.pickupLat != null && assignedOrder.pickupLng != null
                ? { lat: assignedOrder.pickupLat, lng: assignedOrder.pickupLng }
                : orderCoords.length > 0
                    ? orderCoords[seed % orderCoords.length]
                    : DEFAULT_CENTER;
        const liveEnabled = presence?.enabled ?? driver.liveLocationEnabled ?? true;
        const heartbeatAt = pickLatestIso([location?.recordedAt ?? null, presence?.heartbeatAt ?? null]);
        const status = deriveDriverStatus(heartbeatAt, liveEnabled);
        const lastSeenAt = heartbeatAt ??
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
            region: (driver.warehouseId ? (warehouseRegionById.get(driver.warehouseId) ?? null) : null) ??
                (warehouseIds.length > 0
                    ? (warehouseRegionById.get(warehouseIds[0]) ?? null)
                    : null),
            warehouseIds,
            driverType: driver.driverType === client_1.DriverType.linehaul ? "linehaul" : "local",
            activeOrderId: location?.orderId ?? assignedOrder?.id ?? null,
            seed,
        };
    });
    return {
        generatedAt: new Date().toISOString(),
        drivers,
        orders,
        warehouses,
        isMock: false,
    };
}
async function ingestDriverLocation(args) {
    const parsed = driverLocationSchema.parse(args.body);
    const role = args.actor.role;
    let targetDriverId = args.actor.userId;
    if (role === client_1.AppRole.manager && parsed.driverId) {
        targetDriverId = parsed.driverId;
    }
    if (role !== client_1.AppRole.manager && parsed.driverId && parsed.driverId !== args.actor.userId) {
        throw new Error("Driver cannot submit location for a different driver");
    }
    const recordedAt = parsed.recordedAt ? new Date(parsed.recordedAt) : new Date();
    if (Number.isNaN(recordedAt.getTime())) {
        throw new Error("Invalid recordedAt timestamp");
    }
    const targetDriver = await prismaClient_1.default.user.findUnique({
        where: { id: targetDriverId },
        select: { id: true, role: true, warehouseId: true, liveLocationEnabled: true },
    });
    if (!targetDriver || targetDriver.role !== client_1.AppRole.driver) {
        throw new Error("Target driver not found");
    }
    const location = {
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
    await (0, liveMapStore_1.upsertDriverLocation)(location);
    const presence = await (0, liveMapStore_1.touchDriverPresenceHeartbeat)({
        driverId: targetDriver.id,
        heartbeatAt: location.recordedAt,
    });
    const status = deriveDriverStatus(presence.heartbeatAt ?? location.recordedAt, targetDriver.liveLocationEnabled);
    await (0, liveMapStore_1.publishLiveMapEvent)({
        type: "driver_location_upsert",
        at: new Date().toISOString(),
        payload: {
            ...location,
            status,
            liveEnabled: targetDriver.liveLocationEnabled,
            heartbeatAt: presence.heartbeatAt,
        },
    });
    return {
        ok: true,
        location,
        status,
        liveEnabled: targetDriver.liveLocationEnabled,
    };
}
async function getDriverPresence(args) {
    const parsedQuery = driverPresenceQuerySchema.parse(args.query ?? {});
    const targetDriverId = resolveTargetDriverId({
        actor: args.actor,
        requestedDriverId: parsedQuery.driverId,
    });
    const targetDriver = await prismaClient_1.default.user.findUnique({
        where: { id: targetDriverId },
        select: {
            id: true,
            role: true,
            liveLocationEnabled: true,
            liveLocationUpdatedAt: true,
        },
    });
    if (!targetDriver || targetDriver.role !== client_1.AppRole.driver) {
        throw new Error("Target driver not found");
    }
    const presences = await (0, liveMapStore_1.readDriverPresences)([targetDriver.id]);
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
        },
        status: deriveDriverStatus(heartbeatAt, enabled),
    };
}
async function setDriverPresence(args) {
    const parsed = driverPresenceUpdateSchema.parse(args.body);
    const targetDriverId = resolveTargetDriverId({
        actor: args.actor,
        requestedDriverId: parsed.driverId,
    });
    const targetDriver = await prismaClient_1.default.user.findUnique({
        where: { id: targetDriverId },
        select: {
            id: true,
            role: true,
        },
    });
    if (!targetDriver || targetDriver.role !== client_1.AppRole.driver) {
        throw new Error("Target driver not found");
    }
    const now = new Date();
    const updatedDriver = await prismaClient_1.default.user.update({
        where: { id: targetDriver.id },
        data: {
            liveLocationEnabled: parsed.enabled,
            liveLocationUpdatedAt: now,
        },
        select: {
            id: true,
            liveLocationEnabled: true,
            liveLocationUpdatedAt: true,
        },
    });
    const presences = await (0, liveMapStore_1.readDriverPresences)([updatedDriver.id]);
    const currentPresence = presences.get(updatedDriver.id) ?? null;
    const nextPresence = {
        driverId: updatedDriver.id,
        enabled: updatedDriver.liveLocationEnabled,
        heartbeatAt: currentPresence?.heartbeatAt ?? null,
        updatedAt: updatedDriver.liveLocationUpdatedAt.toISOString(),
    };
    await (0, liveMapStore_1.upsertDriverPresence)(nextPresence);
    const status = deriveDriverStatus(nextPresence.heartbeatAt, nextPresence.enabled);
    await (0, liveMapStore_1.publishLiveMapEvent)({
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
async function heartbeatDriverPresence(args) {
    const parsed = driverPresenceHeartbeatSchema.parse(args.body);
    const targetDriverId = resolveTargetDriverId({
        actor: args.actor,
        requestedDriverId: parsed.driverId,
    });
    const targetDriver = await prismaClient_1.default.user.findUnique({
        where: { id: targetDriverId },
        select: {
            id: true,
            role: true,
            liveLocationEnabled: true,
        },
    });
    if (!targetDriver || targetDriver.role !== client_1.AppRole.driver) {
        throw new Error("Target driver not found");
    }
    const heartbeatAt = parsed.recordedAt
        ? new Date(parsed.recordedAt).toISOString()
        : new Date().toISOString();
    const touched = await (0, liveMapStore_1.touchDriverPresenceHeartbeat)({
        driverId: targetDriver.id,
        heartbeatAt,
    });
    const nextPresence = {
        ...touched,
        enabled: targetDriver.liveLocationEnabled,
    };
    await (0, liveMapStore_1.upsertDriverPresence)(nextPresence);
    const status = deriveDriverStatus(nextPresence.heartbeatAt, nextPresence.enabled);
    await (0, liveMapStore_1.publishLiveMapEvent)({
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
