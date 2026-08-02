import type {
  LiveMapActor,
  LiveMapEvent,
  LiveMapViewport,
} from "./liveMap.types";

function isInViewport(lat: number, lng: number, viewport: LiveMapViewport) {
  return (
    lat >= viewport.minLat &&
    lat <= viewport.maxLat &&
    lng >= viewport.minLng &&
    lng <= viewport.maxLng
  );
}

export function canDeliverLiveMapEvent(args: {
  actor: LiveMapActor;
  event: LiveMapEvent;
  viewport?: LiveMapViewport | null;
}) {
  const { actor, event, viewport } = args;
  if (actor.permissionCodes.includes("drivers.manage")) return true;
  if (!actor.warehouseId || event.type !== "driver_location_upsert") return false;

  if (
    event.payload.warehouseId &&
    event.payload.warehouseId !== actor.warehouseId
  ) {
    return false;
  }

  return viewport
    ? isInViewport(event.payload.lat, event.payload.lng, viewport)
    : true;
}
