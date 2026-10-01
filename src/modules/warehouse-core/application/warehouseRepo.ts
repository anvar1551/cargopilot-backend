import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import type { WarehouseTypeValue } from "./warehouse.shared";
import { buildOrderScopeWhere } from "../../identity-access/access-control";
import { WAREHOUSE_SELECT, WAREHOUSE_DETAIL_SELECT } from "./warehouseProjection";
import { requireWarehouseAccess, rejectWarehouseFields, warehouseAccessError } from "./warehouseAccess";

type WarehouseInput = { name: string; type: WarehouseTypeValue; location: string;
  region?: string | null; latitude?: number | null; longitude?: number | null };
function data(input: WarehouseInput) {
  rejectWarehouseFields(input);
  return { name: input.name, type: input.type, location: input.location, region: input.region ?? null,
    latitude: input.latitude ?? null, longitude: input.longitude ?? null };
}
export async function createWarehouse(context: AppUser, input: WarehouseInput) {
  const { snapshot } = await requireWarehouseAccess(context, "warehouse.create");
  return prisma.warehouse.create({ select: WAREHOUSE_SELECT, data: { ...data(input), tenantId: snapshot.tenantId } });
}
export async function updateWarehouse(context: AppUser, id: string, input: WarehouseInput) {
  const { where } = await requireWarehouseAccess(context, "shipment.update");
  return prisma.warehouse.update({ select: WAREHOUSE_SELECT, where: { id, AND: [where] }, data: data(input) });
}
function pagination(options: { search?: string; page?: number; limit?: number }) {
  const { search = "", page = 1, limit = 100 } = options;
  if (typeof search !== "string" || search.length > 120 || !Number.isSafeInteger(page) || page < 1 || page > 10000 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw warehouseAccessError("Invalid warehouse query", 400);
  return { search: search.trim(), skip: (page - 1) * limit, take: limit };
}
export async function listWarehouses(context: AppUser, options: { search?: string; page?: number; limit?: number } = {}) {
  const { where } = await requireWarehouseAccess(context, "shipment.view");
  const { search, skip, take } = pagination(options);
  return prisma.warehouse.findMany({ where: { ...where, ...(search ? { name: { contains: search, mode: "insensitive" as const } } : {}) },
    select: WAREHOUSE_SELECT, skip, take, orderBy: [{ createdAt: "desc" }, { id: "asc" }] });
}
export async function getWarehouseById(context: AppUser, id: string) {
  const { where, snapshot } = await requireWarehouseAccess(context, "shipment.view");
  const orderScope = await buildOrderScopeWhere(context, "shipment.view");
  return prisma.warehouse.findFirst({ where: { AND: [where, { id }] }, select: {
    ...WAREHOUSE_DETAIL_SELECT,
    orders: { ...WAREHOUSE_DETAIL_SELECT.orders, where: { AND: [
      { tenantId: snapshot.tenantId, ownerOrgId: snapshot.companyId }, orderScope ?? { id: "__no_access__" },
    ] }, take: 100, orderBy: [{ createdAt: "desc" }, { id: "asc" }] },
  } });
}
