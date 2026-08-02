"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.canDeliverLiveMapEvent = canDeliverLiveMapEvent;
function isInViewport(lat, lng, viewport) {
    return (lat >= viewport.minLat &&
        lat <= viewport.maxLat &&
        lng >= viewport.minLng &&
        lng <= viewport.maxLng);
}
function canDeliverLiveMapEvent(args) {
    const { actor, event, viewport } = args;
    if (actor.permissionCodes.includes("drivers.manage"))
        return true;
    if (!actor.warehouseId || event.type !== "driver_location_upsert")
        return false;
    if (event.payload.warehouseId &&
        event.payload.warehouseId !== actor.warehouseId) {
        return false;
    }
    return viewport
        ? isInViewport(event.payload.lat, event.payload.lng, viewport)
        : true;
}
