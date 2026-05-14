export const SERVICE_TYPES = [
  "DOOR_TO_DOOR",
  "DOOR_TO_POINT",
  "POINT_TO_DOOR",
  "POINT_TO_POINT",
] as const;

export type ServiceTypeValue = (typeof SERVICE_TYPES)[number];

export const DEFAULT_SERVICE_TYPE: ServiceTypeValue = "DOOR_TO_DOOR";

const LEGACY_TO_SERVICE_TYPE: Record<string, ServiceTypeValue> = {
  DOOR_TO_DOOR: "DOOR_TO_DOOR",
  "DOOR TO DOOR": "DOOR_TO_DOOR",
  EXPRESS: "DOOR_TO_DOOR",
  SAME_DAY: "DOOR_TO_DOOR",
  "SAME DAY": "DOOR_TO_DOOR",
  ECONOMY: "DOOR_TO_DOOR",
  DOOR_TO_POINT: "DOOR_TO_POINT",
  "DOOR TO POINT": "DOOR_TO_POINT",
  POINT_TO_DOOR: "POINT_TO_DOOR",
  "POINT TO DOOR": "POINT_TO_DOOR",
  POINT_TO_POINT: "POINT_TO_POINT",
  "POINT TO POINT": "POINT_TO_POINT",
};

export function normalizeServiceTypeInput(
  value?: string | null,
): ServiceTypeValue {
  const normalized = String(value || "")
    .trim()
    .replace(/-/g, "_")
    .replace(/\s+/g, "_")
    .toUpperCase();

  return LEGACY_TO_SERVICE_TYPE[normalized] ?? DEFAULT_SERVICE_TYPE;
}
