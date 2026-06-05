export function makeScopeKey(args: {
  role?: string | null;
  warehouseId?: string | null;
  userId?: string | null;
}) {
  if (args.role === "warehouse" && args.warehouseId) {
    return `warehouse:${args.warehouseId}`;
  }
  return `role:${args.role || "global"}`;
}
