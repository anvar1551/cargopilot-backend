import { createHash } from "node:crypto";
import { z } from "zod";

export const DELEGATION_REVISION = "operational-delegation.v1";
export const OPERATIONAL_PROFILES = Object.freeze({
  "operational-clerk.v1": Object.freeze(["organizations.read", "customers.read", "customers.write", "shipment.view", "shipment.create", "notifications.read"]),
  "operational-dispatcher.v1": Object.freeze(["organizations.read", "drivers.read", "shipment.view", "shipment.assignCourier", "shipment.custody.dispatch", "shipment.custody.last-mile-offer", "notifications.read"]),
  "operational-warehouse.v1": Object.freeze(["shipment.view", "shipment.custody.intake", "shipment.custody.receive", "shipment.custody.dispatch", "shipment.custody.last-mile-offer", "notifications.read"]),
});
export type OperationalProfile = keyof typeof OPERATIONAL_PROFILES;
export const profileSchema = z.enum(["operational-clerk.v1", "operational-dispatcher.v1", "operational-warehouse.v1"]);
export const operationIdSchema = z.string().uuid().transform(v => v.toLowerCase());
export const warehouseIdsSchema = z.array(operationIdSchema).max(20).transform(ids => [...new Set(ids)].sort());
export const reasonSchema = z.string().trim().min(1).max(500).regex(/^[^\u0000-\u001f\u007f]+$/);
export const profileIntentSchema = z.object({ operationId: operationIdSchema, profileRevision: profileSchema,
  warehouseIds: warehouseIdsSchema, reason: reasonSchema }).strict().superRefine((v, ctx) => {
  if ((v.profileRevision === "operational-warehouse.v1") !== (v.warehouseIds.length > 0))
    ctx.addIssue({ code: "custom", message: "Exact warehouse scopes required only for warehouse profile" });
});
export function delegationFingerprint(action: string, value: unknown) {
  return createHash("sha256").update(JSON.stringify({ version: 1, action, value })).digest("hex");
}
