import type { LiveMapActor, LiveMapEvent, LiveMapViewport } from "./liveMap.types";

/** Current legacy events have no authoritative tenant/company execution context.
 * Warehouse/user IDs or manager permissions cannot establish event ownership.
 * Restore delivery only with server-owned evidence and fresh recipient checks.
 */
export function canDeliverLiveMapEvent(_args: {actor:LiveMapActor;event:LiveMapEvent;viewport?:LiveMapViewport|null}) {
  return false;
}
