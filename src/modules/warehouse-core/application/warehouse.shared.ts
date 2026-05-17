export const WAREHOUSE_TYPES = ["warehouse", "pickup_point"] as const;

export type WarehouseTypeValue = (typeof WAREHOUSE_TYPES)[number];

export const DEFAULT_WAREHOUSE_TYPE: WarehouseTypeValue = "warehouse";

export function normalizeWarehouseType(value?: string | null): WarehouseTypeValue {
  const normalized = String(value || "")
    .trim()
    .replace(/[-\s]+/g, "_")
    .toLowerCase();

  return WAREHOUSE_TYPES.includes(normalized as WarehouseTypeValue)
    ? (normalized as WarehouseTypeValue)
    : DEFAULT_WAREHOUSE_TYPE;
}
