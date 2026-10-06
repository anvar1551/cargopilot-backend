import { z } from "zod";
export const CASH_CAPABILITY_DELEGATION_REVISION = "cash-delegation.v1";
export const CASH_CAPABILITY_PROFILES = Object.freeze({
 "local-driver-cash.v1": ["cash.custody.read","cash.collect","cash.handoff"],
 "warehouse-cash.v1": ["cash.custody.read","cash.collect","cash.handoff"],
 "cash-settlement-checker.v1": ["cash.custody.read","cash.settle"],
} as const);
export const cashCapabilityProfileSchema=z.enum(["local-driver-cash.v1","warehouse-cash.v1","cash-settlement-checker.v1"]);
export const cashCapabilityProfilesSchema=z.array(cashCapabilityProfileSchema).length(1);
export const cashKindsSchema=z.array(z.enum(["cod","service_charge"])).min(1).max(2).refine(v=>new Set(v).size===v.length).transform(v=>[...v].sort());
