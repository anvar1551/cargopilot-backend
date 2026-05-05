import { AppRole } from "@prisma/client";
import { createHash } from "crypto";
import type { Request, Response } from "express";
import { ZodError } from "zod";
import { getRedisClient, getRedisPrefix } from "../../config/redis";
import { subscribeLiveMapEvents } from "./liveMapStore";
import { recordSseConnected, recordSseDisconnected } from "../observability/opsMetrics";
import {
  getDriverPresence,
  getLiveMapSnapshot,
  heartbeatDriverPresence,
  ingestDriverLocation,
  setDriverPresence,
} from "./liveMapService";
import type { LiveMapViewport, ManagerLiveMapSnapshot } from "./liveMap.types";

function getActor(req: Request) {
  const role = req.user?.role;
  const warehouseId = req.user?.warehouseId ?? null;
  const userId = req.user?.id;
  if (!role || !userId) return null;
  return { role, warehouseId, userId };
}

function handleLiveMapActionError(res: Response, err: any, fallbackMessage: string) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "Invalid payload",
      issues: err.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  if (typeof err?.message === "string" && err.message.includes("different driver")) {
    return res.status(403).json({ error: err.message });
  }
  if (typeof err?.message === "string" && err.message.includes("required for manager")) {
    return res.status(400).json({ error: err.message });
  }
  if (typeof err?.message === "string" && err.message.includes("not found")) {
    return res.status(404).json({ error: err.message });
  }
  return res.status(400).json({ error: err?.message || fallbackMessage });
}

const liveMapSnapshotCache = new Map<
  string,
  { expiresAt: number; payload: ManagerLiveMapSnapshot }
>();

const liveMapCacheGcTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of liveMapSnapshotCache.entries()) {
    if (now >= entry.expiresAt) liveMapSnapshotCache.delete(key);
  }
}, 60_000);
liveMapCacheGcTimer.unref();

function getSnapshotCacheKey(role: AppRole, warehouseId: string | null) {
  return `${role}:${warehouseId ?? "all"}`;
}

function parseViewportFromRequest(req: Request): LiveMapViewport | null {
  const minLat = Number(req.query.minLat);
  const minLng = Number(req.query.minLng);
  const maxLat = Number(req.query.maxLat);
  const maxLng = Number(req.query.maxLng);
  const values = [minLat, minLng, maxLat, maxLng];
  if (values.some((value) => !Number.isFinite(value))) return null;
  if (minLat < -90 || maxLat > 90 || minLng < -180 || maxLng > 180) return null;
  if (minLat >= maxLat || minLng >= maxLng) return null;
  return { minLat, minLng, maxLat, maxLng };
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

function getSnapshotRedisKey(rawKey: string) {
  const digest = createHash("sha1").update(rawKey).digest("hex");
  return `${getRedisPrefix()}:live-map:snapshot:${digest}`;
}

async function readSnapshotCache(key: string): Promise<ManagerLiveMapSnapshot | null> {
  const memoryHit = liveMapSnapshotCache.get(key);
  if (memoryHit && Date.now() < memoryHit.expiresAt) return memoryHit.payload;
  if (memoryHit) liveMapSnapshotCache.delete(key);

  try {
    const redis = await getRedisClient();
    if (!redis) return null;

    const redisHit = await redis.get(getSnapshotRedisKey(key));
    if (!redisHit) return null;
    return JSON.parse(redisHit) as ManagerLiveMapSnapshot;
  } catch (err: any) {
    console.error(`[live-map-cache] redis read failed: ${err?.message || "unknown"}`);
    return null;
  }
}

async function writeSnapshotCache(
  key: string,
  payload: ManagerLiveMapSnapshot,
  ttlMs: number,
) {
  liveMapSnapshotCache.set(key, {
    payload,
    expiresAt: Date.now() + ttlMs,
  });

  try {
    const redis = await getRedisClient();
    if (!redis) return;
    const ttlSec = Math.max(1, Math.floor(ttlMs / 1000));
    await redis.set(getSnapshotRedisKey(key), JSON.stringify(payload), "EX", ttlSec);
  } catch (err: any) {
    console.error(`[live-map-cache] redis write failed: ${err?.message || "unknown"}`);
  }
}

export async function getLiveMapSnapshotController(req: Request, res: Response) {
  try {
    const actor = getActor(req);
    if (!actor) return res.status(401).json({ error: "Unauthorized" });
    const viewport = parseViewportFromRequest(req);
    const viewportKey = viewport
      ? `:${viewport.minLat.toFixed(4)},${viewport.minLng.toFixed(4)},${viewport.maxLat.toFixed(
          4,
        )},${viewport.maxLng.toFixed(4)}`
      : ":all";
    const cacheKey = `${getSnapshotCacheKey(actor.role, actor.warehouseId)}${viewportKey}`;
    const cacheTtlMs = Math.min(
      Math.max(Number(process.env.LIVE_MAP_SNAPSHOT_CACHE_TTL_MS || 45_000), 1_000),
      120_000,
    );

    const cached = await readSnapshotCache(cacheKey);
    if (cached) {
      res.setHeader("X-Live-Map-Cache", "HIT");
      res.setHeader("Cache-Control", `private, max-age=${Math.floor(cacheTtlMs / 1000)}`);
      return res.json(cached);
    }

    const snapshot = await getLiveMapSnapshot({
      actor: {
        role: actor.role,
        warehouseId: actor.warehouseId,
      },
      viewport,
    });

    await writeSnapshotCache(cacheKey, snapshot, cacheTtlMs);
    res.setHeader("X-Live-Map-Cache", "MISS");
    res.setHeader("Cache-Control", `private, max-age=${Math.floor(cacheTtlMs / 1000)}`);
    return res.json(snapshot);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Failed to fetch live map snapshot" });
  }
}

export async function ingestDriverLocationController(req: Request, res: Response) {
  try {
    const actor = getActor(req);
    if (!actor) return res.status(401).json({ error: "Unauthorized" });
    if (actor.role !== AppRole.driver && actor.role !== AppRole.manager) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const result = await ingestDriverLocation({
      actor: {
        role: actor.role,
        warehouseId: actor.warehouseId,
        userId: actor.userId,
      },
      body: req.body,
    });

    return res.json(result);
  } catch (err: any) {
    return handleLiveMapActionError(res, err, "Failed to ingest driver location");
  }
}

export async function getDriverPresenceController(req: Request, res: Response) {
  try {
    const actor = getActor(req);
    if (!actor) return res.status(401).json({ error: "Unauthorized" });
    if (actor.role !== AppRole.driver && actor.role !== AppRole.manager) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const result = await getDriverPresence({
      actor: {
        role: actor.role,
        warehouseId: actor.warehouseId,
        userId: actor.userId,
      },
      query: req.query,
    });

    return res.json(result);
  } catch (err: any) {
    return handleLiveMapActionError(res, err, "Failed to fetch driver presence");
  }
}

export async function setDriverPresenceController(req: Request, res: Response) {
  try {
    const actor = getActor(req);
    if (!actor) return res.status(401).json({ error: "Unauthorized" });
    if (actor.role !== AppRole.driver && actor.role !== AppRole.manager) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const result = await setDriverPresence({
      actor: {
        role: actor.role,
        warehouseId: actor.warehouseId,
        userId: actor.userId,
      },
      body: req.body,
    });

    return res.json(result);
  } catch (err: any) {
    return handleLiveMapActionError(res, err, "Failed to update driver presence");
  }
}

export async function heartbeatDriverPresenceController(req: Request, res: Response) {
  try {
    const actor = getActor(req);
    if (!actor) return res.status(401).json({ error: "Unauthorized" });
    if (actor.role !== AppRole.driver && actor.role !== AppRole.manager) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const result = await heartbeatDriverPresence({
      actor: {
        role: actor.role,
        warehouseId: actor.warehouseId,
        userId: actor.userId,
      },
      body: req.body,
    });

    return res.json(result);
  } catch (err: any) {
    return handleLiveMapActionError(res, err, "Failed to heartbeat driver presence");
  }
}

export async function streamLiveMapController(req: Request, res: Response) {
  const actor = getActor(req);
  if (!actor) return res.status(401).json({ error: "Unauthorized" });
  const viewport = parseViewportFromRequest(req);
  const clientKey = `${req.user?.id || "anon"}:${req.ip || "ip"}`;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  recordSseConnected({ stream: "live-map", clientKey });

  res.write(`event: ready\ndata: ${JSON.stringify({ connectedAt: new Date().toISOString() })}\n\n`);

  const heartbeatMs = Math.max(10000, Number(process.env.LIVE_MAP_STREAM_HEARTBEAT_MS || 25000));
  const heartbeat = setInterval(() => {
    res.write(`: keepalive ${Date.now()}\n\n`);
  }, heartbeatMs);

  const unsubscribe = subscribeLiveMapEvents((event) => {
    if (actor.role === AppRole.warehouse && actor.warehouseId) {
      if (event.type !== "driver_location_upsert") return;
      if (event.type === "driver_location_upsert") {
        const eventWarehouseId = event.payload.warehouseId;
        if (eventWarehouseId && eventWarehouseId !== actor.warehouseId) return;
      }
    }
    if (viewport && event.type === "driver_location_upsert") {
      if (!isInViewport(event.payload.lat, event.payload.lng, viewport)) return;
    }
    res.write(`event: live-map\ndata: ${JSON.stringify(event)}\n\n`);
  });

  req.on("close", () => {
    recordSseDisconnected("live-map");
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });

  return undefined;
}
