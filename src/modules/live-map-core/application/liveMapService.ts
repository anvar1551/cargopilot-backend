import { OrderStatus, Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import { buildOrderScopeWhere } from "../../identity-access/access-control";
import type { AppUser } from "../../../types/app-user";
import type { LiveMapViewport, ManagerLiveMapOrder, ManagerLiveMapSnapshot } from "./liveMap.types";
export { ingestDriverLocation, ingestDriverTelemetry, getDriverPresence, setDriverPresence, heartbeatDriverPresence } from "./selectedDriverTelemetry";

function readIntEnv(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
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

function toLatitude(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= -90 && value <= 90 ? value : null;
}

function toLongitude(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= -180 && value <= 180 ? value : null;
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

/** Fresh selected order visibility; unowned telemetry must not enter this projection. */
export async function getLiveMapSnapshot(args: {
  actor: AppUser;
  viewport?: LiveMapViewport | null;
}): Promise<ManagerLiveMapSnapshot> {
  const actor=args.actor;
  if(!actor?.id || !actor.tenantId || !actor.companyId || !actor.companyMembershipId ||
      !actor.tenantMembershipId || actor.membershipId!==actor.companyMembershipId)
    throw Object.assign(new Error("Tenant-bound live map context required"),{statusCode:403});
  const viewport=args.viewport??null;
  if(viewport && (!Object.values(viewport).every(Number.isFinite) || viewport.minLat < -90 ||
      viewport.maxLat>90 || viewport.minLng < -180 || viewport.maxLng>180 ||
      viewport.minLat>=viewport.maxLat || viewport.minLng>=viewport.maxLng))
    throw Object.assign(new Error("Invalid live map viewport"),{statusCode:400});
  const scope=await buildOrderScopeWhere(actor,"shipment.view");
  if(!scope || scope.id==="__no_access__") throw Object.assign(new Error("Order permission and scope required"),{statusCode:403});
  const recentFrom=new Date(Date.now()-readIntEnv("LIVE_MAP_RECENT_HOURS",24,1,24*14)*60*60*1000);
  const rows=await prisma.order.findMany({where:{AND:[
    {tenantId:actor.tenantId},scope,getOrderViewportWhere(viewport),
    {OR:[{status:{in:liveMapOrderStatuses}},{updatedAt:{gte:recentFrom}}]},
  ]},select:{id:true,orderNumber:true,status:true,pickupLat:true,pickupLng:true,dropoffLat:true,dropoffLng:true},
    orderBy:[{updatedAt:"desc"},{id:"desc"}],take:readIntEnv("LIVE_MAP_SNAPSHOT_ORDER_LIMIT",180,20,1000)});
  return {generatedAt:new Date().toISOString(),
    orders:rows.map(row=>mapOrderRecord({...row,assignedDriverId:null,currentWarehouseId:null,currentWarehouse:null})),
    drivers:[],warehouses:[],isMock:false,isPartial:true};
}
