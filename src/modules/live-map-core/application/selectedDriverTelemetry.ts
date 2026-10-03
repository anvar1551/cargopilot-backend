import { z } from "zod";
import type { AppUser } from "../../../types/app-user";
import prisma from "../../../config/prismaClient";
import { loadAccessSnapshot } from "../../identity-access/access-control";
import { requireAuthorizedOrder } from "../../orders-core/domain/order-access";
import { requireTenantBoundOrderCompanyAuthority } from "../../orders-core/domain/company-authority";
import {
  readSelectedPresence, readSelectedTelemetry, writeSelectedPresence, writeSelectedTelemetry,
  type TelemetryContext,
} from "../infrastructure/selectedTelemetryStore";

const reference = z.string().min(1).max(80);
const contextSchema = z.object({
  userId: reference, tenantId: reference, tenantMembershipId: reference,
  companyId: reference, companyMembershipId: reference,
}).strict();
const bindingSchema = z.object({ context: contextSchema, driverId: z.string().uuid().optional() });
const presenceSchema = bindingSchema.extend({ enabled: z.boolean() }).strict();
const telemetrySchema = bindingSchema.extend({
  lat: z.number().finite().min(-90).max(90).optional(),
  lng: z.number().finite().min(-180).max(180).optional(),
  speedKmh: z.number().finite().min(0).max(220).optional(),
  headingDeg: z.number().finite().min(0).max(360).optional(),
  accuracyM: z.number().finite().min(0).max(5000).optional(),
  recordedAt: z.string().datetime().optional(),
  orderId: z.string().uuid().optional(),
}).strict().superRefine((value, issue) => {
  if ((value.lat == null) !== (value.lng == null) ||
      (value.lat == null && [value.speedKmh, value.headingDeg, value.accuracyM, value.orderId].some(item => item != null))) {
    issue.addIssue({ code: z.ZodIssueCode.custom, message: "Location details require both coordinates" });
  }
});
const heartbeatSchema = bindingSchema.extend({ recordedAt: z.string().datetime().optional() }).strict();
const fail = (message: string, statusCode = 403): never => { throw Object.assign(new Error(message), { statusCode }); };

async function authorize(actor: AppUser, expected: TelemetryContext, driverId?: string): Promise<TelemetryContext> {
  if (!actor?.id || !actor.tenantId || !actor.companyId || !actor.tenantMembershipId ||
      !actor.companyMembershipId || actor.membershipId !== actor.companyMembershipId) fail("Selected context required");
  const context: TelemetryContext = {
    userId: actor.id, tenantId: actor.tenantId, tenantMembershipId: actor.tenantMembershipId,
    companyId: actor.companyId, companyMembershipId: actor.companyMembershipId,
  };
  if (Object.keys(context).some(key => context[key as keyof TelemetryContext] !== expected[key as keyof TelemetryContext])) {
    fail("Original telemetry context does not match this session");
  }
  if (driverId && driverId !== actor.id) fail("Delegated driver telemetry unavailable");
  const snapshot = await loadAccessSnapshot({ ...context, membershipId: actor.membershipId, requireFresh: true });
  if (!snapshot || !snapshot.permissionCodes.includes("drivers.telemetry")) fail("Current telemetry permission required");
  // The general snapshot does not certify ownership of attached role definitions.
  // Reuse the authoritative company-role check; foreign company roles grant nothing.
  await requireTenantBoundOrderCompanyAuthority(prisma, actor, "drivers.telemetry");
  // Self-service permission applies only to this human's explicitly selected active membership.
  // User.driverType/warehouseId, permissions in another company and manager claims grant nothing.
  return context;
}

function presenceResult(context: TelemetryContext, enabled: boolean, updatedAt: string | null, heartbeatAt: string | null) {
  const age = heartbeatAt ? Math.max(0, Date.now() - Date.parse(heartbeatAt)) : Infinity;
  return {
    ok: true,
    presence: { driverId: context.userId, enabled, heartbeatAt, updatedAt },
    status: !enabled ? "offline" : age <= 70_000 ? "online" : age <= 180_000 ? "idle" : age <= 600_000 ? "stale" : "offline",
  };
}

export async function getDriverPresence(args: { actor: AppUser; query: unknown }) {
  const raw = args.query as Record<string, unknown> | null;
  let suppliedContext: unknown = raw?.context;
  if (typeof suppliedContext === "string") {
    if (suppliedContext.length > 1024) fail("Invalid context", 400);
    try { suppliedContext = JSON.parse(suppliedContext); } catch { fail("Invalid context", 400); }
  }
  const parsed = bindingSchema.strict().parse({ ...raw, context: suppliedContext });
  const context = await authorize(args.actor, parsed.context, parsed.driverId);
  const enabled = await readSelectedPresence(context);
  const telemetry = await readSelectedTelemetry(context);
  return presenceResult(context, enabled?.enabled ?? false, enabled?.updatedAt ?? null, telemetry?.receivedAt ?? null);
}

export async function setDriverPresence(args: { actor: AppUser; body: unknown }) {
  const parsed = presenceSchema.parse(args.body);
  const context = await authorize(args.actor, parsed.context, parsed.driverId);
  const updatedAt = new Date().toISOString();
  await writeSelectedPresence(context, { enabled: parsed.enabled, updatedAt });
  return presenceResult(context, parsed.enabled, updatedAt, null);
}

export async function ingestDriverTelemetry(args: { actor: AppUser; body: unknown }) {
  const parsed = telemetrySchema.parse(args.body);
  const context = await authorize(args.actor, parsed.context, parsed.driverId);
  if (parsed.orderId) {
    const order = await requireAuthorizedOrder(args.actor, parsed.orderId, "shipment.view");
    if (order.ownerOrgId !== context.companyId || order.assignedDriverId !== context.userId) fail("Selected assigned order required");
  }
  const presence = await readSelectedPresence(context);
  if (parsed.lat != null && !presence?.enabled) fail("Enable selected-context location sharing first", 409);
  const receivedAt = new Date().toISOString();
  const location = parsed.lat == null ? null : {
    driverId: context.userId, warehouseId: null, orderId: parsed.orderId ?? null,
    lat: parsed.lat, lng: parsed.lng!, speedKmh: parsed.speedKmh ?? 0,
    headingDeg: parsed.headingDeg ?? 0, accuracyM: parsed.accuracyM ?? null,
    recordedAt: receivedAt,
  };
  await writeSelectedTelemetry(context, { receivedAt, clientCapturedAt: parsed.recordedAt ?? null, location });
  return {
    ...presenceResult(context, presence?.enabled ?? false, presence?.updatedAt ?? null, receivedAt),
    location, liveEnabled: presence?.enabled ?? false, broadcasted: false,
    clientCapturedAt: parsed.recordedAt ?? null,
  };
}

export async function ingestDriverLocation(args: { actor: AppUser; body: unknown }) {
  const parsed = telemetrySchema.parse(args.body);
  if (parsed.lat == null) fail("Location requires coordinates", 400);
  return ingestDriverTelemetry({ ...args, body: parsed });
}
export async function heartbeatDriverPresence(args: { actor: AppUser; body: unknown }) {
  const parsed = heartbeatSchema.parse(args.body);
  const result = await ingestDriverTelemetry({ ...args, body: parsed });
  return { ok: result.ok, presence: result.presence, status: result.status };
}
