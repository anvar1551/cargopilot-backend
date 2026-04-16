export const WAREHOUSE_TYPES = ["warehouse", "pickup_point"] as const;

export type WarehouseTypeValue = (typeof WAREHOUSE_TYPES)[number];

export const DEFAULT_WAREHOUSE_TYPE: WarehouseTypeValue = "warehouse";

export const WAREHOUSE_CAPABILITIES = {
  warehouse: [
    "inbound_intake",
    "sorting",
    "outbound_dispatch",
    "linehaul_handoff",
    "driver_assignment",
  ],
  pickup_point: [
    "customer_dropoff",
    "customer_pickup",
    "local_batch_scan",
    "driver_assignment",
    "handoff_to_hub",
  ],
} as const;

export type WarehouseCapability =
  (typeof WAREHOUSE_CAPABILITIES)[WarehouseTypeValue][number];

export function normalizeWarehouseType(
  value?: string | null,
): WarehouseTypeValue {
  const normalized = String(value || "")
    .trim()
    .replace(/[-\s]+/g, "_")
    .toLowerCase();

  return WAREHOUSE_TYPES.includes(normalized as WarehouseTypeValue)
    ? (normalized as WarehouseTypeValue)
    : DEFAULT_WAREHOUSE_TYPE;
}
