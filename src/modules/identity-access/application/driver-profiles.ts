import { z } from "zod";
export const DRIVER_DELEGATION_REVISION = "driver-delegation.v1";
export const DRIVER_PROFILES = Object.freeze({
  "local-driver.v1": Object.freeze(["drivers.telemetry", "shipment.changeStatus", "shipment.custody.pickup-offer", "shipment.custody.last-mile-accept", "shipment.custody.deliver", "notifications.read"]),
  "linehaul-driver.v1": Object.freeze(["drivers.telemetry", "shipment.custody.transport-accept", "notifications.read"]),
});
export const driverProfileSchema = z.enum(["local-driver.v1", "linehaul-driver.v1"]);
export type DriverProfile = keyof typeof DRIVER_PROFILES;
export const driverCeilingSchema = z.array(driverProfileSchema).min(1).max(2).transform(values => [...new Set(values)].sort());
export const profileDriverType = (profile: DriverProfile) => profile === "local-driver.v1" ? "local" : "linehaul";
