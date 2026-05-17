export const ACTOR_ROLES = [
  "customer",
  "driver",
  "warehouse",
  "manager",
] as const;

export type ActorRole = (typeof ACTOR_ROLES)[number];

const actorRoleSet = new Set<string>(ACTOR_ROLES);

export function isActorRole(value: unknown): value is ActorRole {
  return typeof value === "string" && actorRoleSet.has(value);
}

export const ROLE_CUSTOMER: ActorRole = "customer";
export const ROLE_DRIVER: ActorRole = "driver";
export const ROLE_WAREHOUSE: ActorRole = "warehouse";
export const ROLE_MANAGER: ActorRole = "manager";
