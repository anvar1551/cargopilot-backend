"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLiveMapSnapshot = getLiveMapSnapshot;
exports.ingestDriverLocation = ingestDriverLocation;
exports.ingestDriverTelemetry = ingestDriverTelemetry;
exports.getDriverPresence = getDriverPresence;
exports.setDriverPresence = setDriverPresence;
exports.heartbeatDriverPresence = heartbeatDriverPresence;
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const liveMapStore_1 = require("../infrastructure/liveMapStore");
function hasPermission(actor, permission) {
    return Array.isArray(actor.permissionCodes) && actor.permissionCodes.includes(permission);
}
const DRIVER_STATUS_ONLINE_SEC = Math.min(Math.max(Number(process.env.LIVE_MAP_DRIVER_ONLINE_SEC || 70), 15), 600);
const DRIVER_STATUS_IDLE_SEC = Math.max(DRIVER_STATUS_ONLINE_SEC, Math.min(Math.max(Number(process.env.LIVE_MAP_DRIVER_IDLE_SEC || 180), 30), 60 * 60));
const DRIVER_STATUS_STALE_SEC = Math.max(DRIVER_STATUS_IDLE_SEC, Math.min(Math.max(Number(process.env.LIVE_MAP_DRIVER_STALE_SEC || 600), 90), 60 * 60 * 24));
const LIVE_MAP_DELTA_MIN_DISTANCE_M = Math.max(1, Number(process.env.LIVE_MAP_DELTA_MIN_DISTANCE_M || 25));
const LIVE_MAP_DELTA_MAX_INTERVAL_SEC = Math.max(1, Number(process.env.LIVE_MAP_DELTA_MAX_INTERVAL_SEC || 10));
const DRIVER_PROFILE_CACHE_TTL_MS = Math.min(Math.max(Number(process.env.LIVE_MAP_DRIVER_PROFILE_CACHE_TTL_MS || 60000), 5000), 10 * 60000);
function readIntEnv(name, fallback, min, max) {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isFinite(value))
        return fallback;
    return Math.min(Math.max(value, min), max);
}
const driverProfileCache = new Map();
const driverProfileCacheGcTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of driverProfileCache.entries()) {
        if (now >= entry.expiresAt)
            driverProfileCache.delete(key);
    }
}, 60000);
driverProfileCacheGcTimer.unref();
function readCachedDriverProfile(driverId) {
    const hit = driverProfileCache.get(driverId);
    if (!hit)
        return null;
    if (Date.now() >= hit.expiresAt) {
        driverProfileCache.delete(driverId);
        return null;
    }
    return hit.profile;
}
function writeCachedDriverProfile(profile) {
    driverProfileCache.set(profile.id, {
        profile,
        expiresAt: Date.now() + DRIVER_PROFILE_CACHE_TTL_MS,
    });
}
const DRIVER_PERMISSION_KEYS = ["drivers.telemetry"];
const DRIVER_EXCLUDED_PERMISSION_KEYS = ["drivers.manage", "policy.override"];
async function hasDriverCapability(userId) {
    const memberships = await prismaClient_1.default.companyMembership.findMany({
        where: {
            userId,
            status: client_1.MembershipStatus.active,
        },
        select: {
            roles: {
                select: {
                    role: {
                        select: {
                            rolePermissions: {
                                select: {
                                    permission: {
                                        select: {
                                            key: true,
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    });
    const permissionSet = new Set();
    for (const membership of memberships) {
        for (const membershipRole of membership.roles) {
            for (const rolePermission of membershipRole.role.rolePermissions) {
                permissionSet.add(rolePermission.permission.key);
            }
        }
    }
    if (!permissionSet.has("drivers.telemetry"))
        return false;
    for (const forbidden of DRIVER_EXCLUDED_PERMISSION_KEYS) {
        if (permissionSet.has(forbidden))
            return false;
    }
    return true;
}
async function getDriverProfile(driverId) {
    const cached = readCachedDriverProfile(driverId);
    if (cached)
        return cached;
    const profile = await prismaClient_1.default.user.findUnique({
        where: { id: driverId },
        select: {
            id: true,
            driverType: true,
            warehouseId: true,
            liveLocationEnabled: true,
            liveLocationUpdatedAt: true,
        },
    });
    if (!profile)
        return null;
    const next = {
        ...profile,
        hasDriverCapability: profile.driverType != null ? true : await hasDriverCapability(profile.id),
    };
    writeCachedDriverProfile(next);
    return next;
}
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
const driverTelemetrySchema = zod_1.z
    .object({
    lat: zod_1.z.number().gte(-90).lte(90).optional(),
    lng: zod_1.z.number().gte(-180).lte(180).optional(),
    speedKmh: zod_1.z.number().min(0).max(220).optional(),
    headingDeg: zod_1.z.number().min(0).max(360).optional(),
    accuracyM: zod_1.z.number().min(0).max(5000).optional(),
    recordedAt: zod_1.z.string().datetime().optional(),
    orderId: zod_1.z.string().uuid().optional(),
    driverId: zod_1.z.string().uuid().optional(),
})
    .superRefine((value, ctx) => {
    const hasLat = typeof value.lat === "number";
    const hasLng = typeof value.lng === "number";
    const hasLocation = hasLat && hasLng;
    if (hasLat !== hasLng) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: "lat and lng must be provided together",
        });
    }
    if (!hasLocation) {
        if (typeof value.speedKmh === "number" ||
            typeof value.headingDeg === "number" ||
            typeof value.accuracyM === "number" ||
            typeof value.orderId === "string") {
            ctx.addIssue({
                code: zod_1.z.ZodIssueCode.custom,
                message: "location details require lat and lng",
            });
        }
    }
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
function isInViewport(lat, lng, viewport) {
    if (!viewport)
        return true;
    return (lat >= viewport.minLat &&
        lat <= viewport.maxLat &&
        lng >= viewport.minLng &&
        lng <= viewport.maxLng);
}
function haversineMeters(aLat, aLng, bLat, bLng) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const earthRadiusM = 6371000;
    const dLat = toRad(bLat - aLat);
    const dLng = toRad(bLng - aLng);
    const lat1 = toRad(aLat);
    const lat2 = toRad(bLat);
    const h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * earthRadiusM * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
function shouldBroadcastLocationDelta(args) {
    const { previous, current } = args;
    if (!previous)
        return true;
    if (previous.orderId !== current.orderId)
        return true;
    if (previous.warehouseId !== current.warehouseId)
        return true;
    const prevTs = new Date(previous.recordedAt).getTime();
    const nextTs = new Date(current.recordedAt).getTime();
    const elapsedSec = Number.isFinite(prevTs) && Number.isFinite(nextTs)
        ? Math.max(0, (nextTs - prevTs) / 1000)
        : LIVE_MAP_DELTA_MAX_INTERVAL_SEC;
    if (elapsedSec >= LIVE_MAP_DELTA_MAX_INTERVAL_SEC)
        return true;
    const movedMeters = haversineMeters(previous.lat, previous.lng, current.lat, current.lng);
    if (movedMeters >= LIVE_MAP_DELTA_MIN_DISTANCE_M)
        return true;
    return false;
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
function getOrderViewportWhere(viewport) {
    if (!viewport)
        return {};
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
function getWarehouseViewportWhere(viewport) {
    if (!viewport)
        return {};
    return {
        latitude: { gte: viewport.minLat, lte: viewport.maxLat },
        longitude: { gte: viewport.minLng, lte: viewport.maxLng },
    };
}
function resolveTargetDriverId(args) {
    const { actor, requestedDriverId } = args;
    if (hasPermission(actor, "drivers.manage")) {
        if (requestedDriverId)
            return requestedDriverId;
        throw new Error("driverId is required for manager action");
    }
    if (requestedDriverId && requestedDriverId !== actor.userId) {
        throw new Error("Driver cannot submit action for a different driver");
    }
    return actor.userId;
}
async function getLiveMapSnapshot(args) {
    const actor = args.actor;
    const viewport = args.viewport ?? null;
    const maxOrders = readIntEnv("LIVE_MAP_SNAPSHOT_ORDER_LIMIT", 180, 20, 1000);
    const maxDrivers = readIntEnv("LIVE_MAP_SNAPSHOT_DRIVER_LIMIT", 180, 20, 500);
    const maxWarehouses = readIntEnv("LIVE_MAP_SNAPSHOT_WAREHOUSE_LIMIT", 250, 20, 1000);
    const recentHours = readIntEnv("LIVE_MAP_RECENT_HOURS", 24, 1, 24 * 14);
    const recentFrom = new Date(Date.now() - recentHours * 60 * 60 * 1000);
    const warehouseScoped = Boolean(actor.warehouseId) && !hasPermission(actor, "drivers.manage");
    const warehouseScope = warehouseScoped
        ? actor.warehouseId
            ? { currentWarehouseId: actor.warehouseId }
            : { currentWarehouseId: "__warehouse_scope_no_access__" }
        : {};
    const driverScope = warehouseScoped
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
    const warehouseListScope = warehouseScoped
        ? actor.warehouseId
            ? { id: actor.warehouseId }
            : { id: "__warehouse_scope_no_access__" }
        : {};
    const orderViewportWhere = getOrderViewportWhere(viewport);
    const warehouseViewportWhere = getWarehouseViewportWhere(viewport);
    const viewportDriverIds = viewport ? await (0, liveMapStore_1.readDriverIdsInViewport)(viewport) : [];
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
    };
    const [orderRowsRaw, warehouseRows] = await Promise.all([
        prismaClient_1.default.order.findMany({
            where: {
                AND: [
                    warehouseScope,
                    orderViewportWhere,
                    {
                        OR: [
                            { status: { in: liveMapOrderStatuses } },
                            { updatedAt: { gte: recentFrom } },
                        ],
                    },
                ],
            },
            select: orderSelect,
            orderBy: {
                updatedAt: "desc",
            },
            take: maxOrders,
        }),
        prismaClient_1.default.warehouse.findMany({
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
    const orderRows = orderRowsRaw
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, maxOrders);
    const orders = orderRows.map(mapOrderRecord);
    const orderByAssignedDriver = new Map();
    const warehouseSeed = new Map();
    for (const order of orders) {
        if (order.assignedDriverId && !orderByAssignedDriver.has(order.assignedDriverId)) {
            orderByAssignedDriver.set(order.assignedDriverId, order);
        }
        if (order.pickupLat != null && order.pickupLng != null) {
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
    const orderAssignedDriverIds = Array.from(new Set(orderRows.map((order) => order.assignedDriverId).filter((id) => Boolean(id))));
    const prioritizedDriverIds = Array.from(new Set([...viewportDriverIds, ...orderAssignedDriverIds])).slice(0, maxDrivers);
    const driverEligibilityWhere = {
        OR: [
            { driverType: { not: null } },
            {
                AND: [
                    {
                        memberships: {
                            some: {
                                status: client_1.MembershipStatus.active,
                                roles: {
                                    some: {
                                        role: {
                                            rolePermissions: {
                                                some: {
                                                    permission: {
                                                        key: { in: [...DRIVER_PERMISSION_KEYS] },
                                                    },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    {
                        NOT: {
                            memberships: {
                                some: {
                                    status: client_1.MembershipStatus.active,
                                    roles: {
                                        some: {
                                            role: {
                                                rolePermissions: {
                                                    some: {
                                                        permission: {
                                                            key: { in: [...DRIVER_EXCLUDED_PERMISSION_KEYS] },
                                                        },
                                                    },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                ],
            },
        ],
    };
    let driverRows = [];
    if (!viewport) {
        driverRows = await prismaClient_1.default.user.findMany({
            where: {
                AND: [driverEligibilityWhere, driverScope],
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
            },
            orderBy: {
                createdAt: "desc",
            },
            take: maxDrivers,
        });
    }
    else {
        const prioritizedDriverRows = prioritizedDriverIds.length > 0
            ? await prismaClient_1.default.user.findMany({
                where: {
                    AND: [driverEligibilityWhere, driverScope, { id: { in: prioritizedDriverIds } }],
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
                },
                orderBy: {
                    createdAt: "desc",
                },
                take: maxDrivers,
            })
            : [];
        if (prioritizedDriverRows.length > 0) {
            driverRows = prioritizedDriverRows;
        }
        else {
            // Viewport fallback: include eligible drivers even before their first location ping
            // so operators can still discover and monitor newly onboarded drivers.
            driverRows = await prismaClient_1.default.user.findMany({
                where: {
                    AND: [driverEligibilityWhere, driverScope],
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
                },
                orderBy: {
                    createdAt: "desc",
                },
                take: maxDrivers,
            });
        }
    }
    const driverIds = driverRows.map((driver) => driver.id);
    const [driverLocations, driverPresences] = await Promise.all([
        (0, liveMapStore_1.readDriverLocations)(driverIds),
        (0, liveMapStore_1.readDriverPresences)(driverIds),
    ]);
    const drivers = driverRows.flatMap((driver) => {
        const seed = hashString(driver.id);
        const assignedOrder = orderByAssignedDriver.get(driver.id) ?? null;
        const location = driverLocations.get(driver.id) ?? null;
        const presence = driverPresences.get(driver.id) ?? null;
        const warehouseIds = driver.warehouseId ? [driver.warehouseId] : [];
        // In RBAC mode, telemetry-capable non-driver profiles are included only after
        // they publish a real location (or are explicitly assigned), to avoid showing
        // admin/operator users as pseudo-drivers.
        if (driver.driverType == null && !location && !assignedOrder) {
            return [];
        }
        const liveEnabled = presence?.enabled ?? driver.liveLocationEnabled ?? true;
        const heartbeatAt = pickLatestIso([location?.recordedAt ?? null, presence?.heartbeatAt ?? null]);
        const status = deriveDriverStatus(heartbeatAt, liveEnabled);
        const lastSeenAt = heartbeatAt ??
            driver.liveLocationUpdatedAt?.toISOString() ??
            driver.createdAt.toISOString();
        return [{
                id: driver.id,
                name: driver.name,
                email: driver.email,
                warehouseId: driver.warehouseId ?? null,
                liveEnabled,
                lat: location?.lat ?? null,
                lng: location?.lng ?? null,
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
            }];
    });
    const viewportFilteredOrders = viewport
        ? orders.filter((order) => {
            const pickupVisible = order.pickupLat != null &&
                order.pickupLng != null &&
                isInViewport(order.pickupLat, order.pickupLng, viewport);
            const dropoffVisible = order.dropoffLat != null &&
                order.dropoffLng != null &&
                isInViewport(order.dropoffLat, order.dropoffLng, viewport);
            return pickupVisible || dropoffVisible;
        })
        : orders;
    const viewportFilteredDrivers = viewport
        ? drivers.filter((driver) => driver.lat == null ||
            driver.lng == null ||
            driverLocations.has(driver.id) ||
            isInViewport(driver.lat, driver.lng, viewport))
        : drivers;
    const viewportFilteredWarehouses = viewport
        ? warehouses.filter((warehouse) => warehouse.lat != null &&
            warehouse.lng != null &&
            isInViewport(warehouse.lat, warehouse.lng, viewport))
        : warehouses;
    return {
        generatedAt: new Date().toISOString(),
        drivers: viewportFilteredDrivers,
        orders: viewportFilteredOrders,
        warehouses: viewportFilteredWarehouses,
        isMock: false,
    };
}
async function ingestDriverLocation(args) {
    const parsed = driverLocationSchema.parse(args.body);
    return ingestDriverTelemetry({
        actor: args.actor,
        body: {
            ...parsed,
            lat: parsed.lat,
            lng: parsed.lng,
        },
    });
}
async function ingestDriverTelemetry(args) {
    const parsed = driverTelemetrySchema.parse(args.body);
    const targetDriverId = resolveTargetDriverId({
        actor: args.actor,
        requestedDriverId: parsed.driverId,
    });
    const targetDriver = await getDriverProfile(targetDriverId);
    if (!targetDriver || (targetDriver.driverType == null && !targetDriver.hasDriverCapability)) {
        throw new Error("Target driver not found");
    }
    const heartbeatAt = parsed.recordedAt
        ? new Date(parsed.recordedAt).toISOString()
        : new Date().toISOString();
    const hasLocation = typeof parsed.lat === "number" && typeof parsed.lng === "number";
    let location = null;
    let broadcasted = false;
    const previousLocation = hasLocation
        ? await (0, liveMapStore_1.readDriverLocation)(targetDriver.id)
        : null;
    if (hasLocation) {
        location = {
            driverId: targetDriver.id,
            warehouseId: targetDriver.warehouseId ?? null,
            lat: parsed.lat,
            lng: parsed.lng,
            speedKmh: parsed.speedKmh ?? 0,
            headingDeg: parsed.headingDeg ?? 0,
            accuracyM: parsed.accuracyM ?? null,
            recordedAt: heartbeatAt,
            orderId: parsed.orderId ?? null,
        };
        await (0, liveMapStore_1.upsertDriverLocation)(location);
    }
    const touchedPresence = await (0, liveMapStore_1.touchDriverPresenceHeartbeat)({
        driverId: targetDriver.id,
        heartbeatAt,
    });
    const nextPresence = {
        ...touchedPresence,
        enabled: targetDriver.liveLocationEnabled,
    };
    await (0, liveMapStore_1.upsertDriverPresence)(nextPresence);
    const status = deriveDriverStatus(nextPresence.heartbeatAt ?? heartbeatAt, nextPresence.enabled);
    if (location) {
        const shouldBroadcast = shouldBroadcastLocationDelta({
            previous: previousLocation,
            current: location,
        });
        if (shouldBroadcast) {
            await (0, liveMapStore_1.publishLiveMapEvent)({
                type: "driver_location_upsert",
                at: heartbeatAt,
                payload: {
                    ...location,
                    status,
                    liveEnabled: nextPresence.enabled,
                    heartbeatAt: nextPresence.heartbeatAt,
                    seq: Date.now(),
                },
            });
            broadcasted = true;
        }
    }
    else {
        await (0, liveMapStore_1.publishLiveMapEvent)({
            type: "driver_presence_heartbeat",
            at: heartbeatAt,
            payload: {
                driverId: targetDriver.id,
                heartbeatAt,
            },
        });
        broadcasted = true;
    }
    return {
        ok: true,
        location,
        presence: nextPresence,
        status,
        liveEnabled: nextPresence.enabled,
        broadcasted,
    };
}
async function getDriverPresence(args) {
    const parsedQuery = driverPresenceQuerySchema.parse(args.query ?? {});
    const targetDriverId = resolveTargetDriverId({
        actor: args.actor,
        requestedDriverId: parsedQuery.driverId,
    });
    const targetDriver = await getDriverProfile(targetDriverId);
    if (!targetDriver || (targetDriver.driverType == null && !targetDriver.hasDriverCapability)) {
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
    const targetDriver = await getDriverProfile(targetDriverId);
    if (!targetDriver || (targetDriver.driverType == null && !targetDriver.hasDriverCapability)) {
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
            driverType: true,
            warehouseId: true,
            liveLocationEnabled: true,
            liveLocationUpdatedAt: true,
        },
    });
    writeCachedDriverProfile({
        ...updatedDriver,
        hasDriverCapability: targetDriver.hasDriverCapability,
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
    const result = await ingestDriverTelemetry({
        actor: args.actor,
        body: {
            recordedAt: parsed.recordedAt,
            driverId: parsed.driverId,
        },
    });
    return {
        ok: true,
        presence: result.presence,
        status: result.status,
    };
}
