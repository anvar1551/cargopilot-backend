import {
  AppRole,
  OrderDocumentType,
  OrderLegStatus,
  PricingComponentSource,
  PricingComponentType,
  TransportMode,
} from "@prisma/client";
import prisma from "../../../config/prismaClient";
import { buildOrderScopeWhere, hasPermission } from "../../../modules/identity-access";
import {
  createPricingComponent,
  listOrderDocuments,
  listOrderLegs,
  listPricingComponents,
  upsertOrderLeg,
} from "../../../modules/orders-legs";
import { orderError, requireOrderActor } from "../orderService.shared";

function asEnumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fieldName: string,
): T | undefined {
  if (value == null || value === "") return undefined;
  const asText = String(value).trim();
  if ((allowed as readonly string[]).includes(asText)) {
    return asText as T;
  }
  throw orderError(`Invalid ${fieldName}: ${asText}`, 400);
}

function parseNumber(value: unknown, fieldName: string, required = false) {
  if (value == null || value === "") {
    if (required) throw orderError(`${fieldName} is required`, 400);
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw orderError(`${fieldName} must be a number`, 400);
  }
  return parsed;
}

async function ensureManagerOrderReadAccess(req: any) {
  if (req.user?.role !== AppRole.manager) return null;
  const canReadOrders = await hasPermission(req.user, "orders.read");
  if (!canReadOrders) {
    throw orderError("Forbidden", 403);
  }
  return buildOrderScopeWhere(req.user);
}

async function assertOrderInScope(req: any, orderId: string) {
  const scopeWhere = await ensureManagerOrderReadAccess(req);
  if (!scopeWhere) return;
  const order = await prisma.order.findFirst({
    where: { AND: [{ id: orderId }, scopeWhere] },
    select: { id: true },
  });
  if (!order) {
    throw orderError("Order not found", 404);
  }
}

/** Lists multimodal legs for one order. */
export async function listLegs(req: any, res: any) {
  try {
    if (req.user?.role !== AppRole.manager) {
      return res.status(403).json({ error: "Forbidden" });
    }
    await assertOrderInScope(req, req.params.id);
    const legs = await listOrderLegs(req.params.id);
    return res.json({ legs });
  } catch (err: any) {
    return res.status(err.statusCode ?? 500).json({ error: err.message ?? "Failed" });
  }
}

/** Creates a new leg or updates existing leg for one order. */
export async function upsertLeg(req: any, res: any) {
  try {
    if (req.user?.role !== AppRole.manager) {
      return res.status(403).json({ error: "Forbidden" });
    }
    await assertOrderInScope(req, req.params.id);
    const actor = requireOrderActor(req.user);

    const leg = await upsertOrderLeg(
      req.params.id,
      {
        legId: req.params.legId ?? req.body?.legId ?? null,
        sequence: parseNumber(req.body?.sequence, "sequence"),
        mode: asEnumValue(
          req.body?.mode,
          Object.values(TransportMode),
          "mode",
        ) as TransportMode | undefined,
        status: asEnumValue(
          req.body?.status,
          Object.values(OrderLegStatus),
          "status",
        ) as OrderLegStatus | undefined,
        fromCountry: req.body?.fromCountry ?? undefined,
        toCountry: req.body?.toCountry ?? undefined,
        transitRoute: req.body?.transitRoute,
        fromWarehouseId: req.body?.fromWarehouseId ?? undefined,
        toWarehouseId: req.body?.toWarehouseId ?? undefined,
        carrierCode: req.body?.carrierCode ?? undefined,
        carrierRef: req.body?.carrierRef ?? undefined,
        vehicleRef: req.body?.vehicleRef ?? undefined,
        plannedDepartureAt: req.body?.plannedDepartureAt ?? undefined,
        plannedArrivalAt: req.body?.plannedArrivalAt ?? undefined,
        actualDepartureAt: req.body?.actualDepartureAt ?? undefined,
        actualArrivalAt: req.body?.actualArrivalAt ?? undefined,
        notes: req.body?.notes ?? undefined,
        metadata: req.body?.metadata,
      },
      actor,
    );

    return res.json({ leg });
  } catch (err: any) {
    return res.status(err.statusCode ?? 500).json({ error: err.message ?? "Failed" });
  }
}

/** Lists order pricing components (multi-currency ledger-style lines). */
export async function listPricing(req: any, res: any) {
  try {
    if (req.user?.role !== AppRole.manager) {
      return res.status(403).json({ error: "Forbidden" });
    }
    await assertOrderInScope(req, req.params.id);
    const items = await listPricingComponents(req.params.id);
    return res.json({ items });
  } catch (err: any) {
    return res.status(err.statusCode ?? 500).json({ error: err.message ?? "Failed" });
  }
}

/** Creates one pricing component line for an order/leg. */
export async function createPricing(req: any, res: any) {
  try {
    if (req.user?.role !== AppRole.manager) {
      return res.status(403).json({ error: "Forbidden" });
    }
    await assertOrderInScope(req, req.params.id);
    const actor = requireOrderActor(req.user);

    const item = await createPricingComponent(
      req.params.id,
      {
        orderLegId: req.body?.orderLegId ?? undefined,
        componentType: asEnumValue(
          req.body?.componentType,
          Object.values(PricingComponentType),
          "componentType",
        ) as PricingComponentType,
        source: asEnumValue(
          req.body?.source,
          Object.values(PricingComponentSource),
          "source",
        ) as PricingComponentSource | undefined,
        description: req.body?.description ?? undefined,
        amount: parseNumber(req.body?.amount, "amount", true)!,
        currency: String(req.body?.currency ?? "").trim(),
        fxRateSnapshot: parseNumber(req.body?.fxRateSnapshot, "fxRateSnapshot"),
        baseCurrency:
          req.body?.baseCurrency != null
            ? String(req.body.baseCurrency).trim()
            : undefined,
        baseAmount: parseNumber(req.body?.baseAmount, "baseAmount"),
        referenceKey: req.body?.referenceKey ?? undefined,
      },
      actor,
    );

    return res.status(201).json({ item });
  } catch (err: any) {
    return res.status(err.statusCode ?? 500).json({ error: err.message ?? "Failed" });
  }
}

/** Lists generated order documents (labels/manifests/route sheets/etc). */
export async function listDocuments(req: any, res: any) {
  try {
    if (req.user?.role !== AppRole.manager) {
      return res.status(403).json({ error: "Forbidden" });
    }
    await assertOrderInScope(req, req.params.id);
    const type = asEnumValue(
      req.query?.type,
      Object.values(OrderDocumentType),
      "type",
    ) as OrderDocumentType | undefined;
    const limit = parseNumber(req.query?.limit, "limit");
    const items = await listOrderDocuments(req.params.id, {
      type: type ?? null,
      limit: limit ?? undefined,
    });
    return res.json({ items });
  } catch (err: any) {
    return res.status(err.statusCode ?? 500).json({ error: err.message ?? "Failed" });
  }
}
