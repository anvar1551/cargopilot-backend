import {
  OrderLegStatus,
  PricingComponentSource,
  PricingComponentType,
  ServiceType,
  TransportMode,
} from "@prisma/client";
import prisma from "../../config/prismaClient";
import { enqueueCargoPilotDomainEventsTx } from "../analytics-core/infrastructure/analyticsOutbox";
import { orderError } from "../orders-core/shared";
import {
  ensureOrderExists,
  resolveActorTenantScope,
  type Actor,
  type CreatePricingComponentInput,
} from "./shared";

const SUPPORTED_CURRENCY_CODES = new Set(["UZS", "USD", "CNY"]);
const SERVICE_CHARGE_REF_KEY = "system:service_charge";
const SERVICE_CHARGE_REF_KEY_PREFIX = `${SERVICE_CHARGE_REF_KEY}:leg:`;

type SystemLegKind = "pickup" | "linehaul" | "last_mile";

type SystemLegTemplate = {
  kind: SystemLegKind;
  sequence: number;
  mode: TransportMode;
  componentType: PricingComponentType;
  description: string;
};

export async function listPricingComponents(orderId: string) {
  await ensureOrderExists(orderId);
  return prisma.pricingComponent.findMany({
    where: { orderId },
    orderBy: [{ createdAt: "desc" }],
  });
}

export async function createPricingComponent(
  orderId: string,
  input: CreatePricingComponentInput,
  actor?: Actor,
) {
  await ensureOrderExists(orderId);
  if (!Number.isFinite(input.amount)) {
    throw orderError("amount must be a finite number", 400);
  }
  if (!input.currency || !input.currency.trim()) {
    throw orderError("currency is required", 400);
  }
  const normalizedCurrency = input.currency.trim().toUpperCase();
  if (!SUPPORTED_CURRENCY_CODES.has(normalizedCurrency)) {
    throw orderError("currency must be one of: UZS, USD, CNY", 400);
  }

  return prisma.$transaction(async (tx) => {
    if (input.orderLegId) {
      const leg = await tx.orderLeg.findFirst({
        where: { id: input.orderLegId, orderId },
        select: { id: true },
      });
      if (!leg) {
        throw orderError("orderLegId is invalid for this order", 400);
      }
    }

    const created = await tx.pricingComponent.create({
      data: {
        orderId,
        orderLegId: input.orderLegId ?? null,
        componentType: input.componentType,
        source: input.source ?? PricingComponentSource.manual,
        description: input.description ?? null,
        amount: input.amount,
        currency: normalizedCurrency,
        fxRateSnapshot: input.fxRateSnapshot ?? null,
        baseCurrency: input.baseCurrency?.trim().toUpperCase() ?? null,
        baseAmount: input.baseAmount ?? null,
        referenceKey: input.referenceKey ?? null,
      },
    });

    await enqueueCargoPilotDomainEventsTx(tx, [
      {
        type: "order_status_changed",
        tenantScope: resolveActorTenantScope(actor),
        entityId: orderId,
        payload: {
          source: "pricing_component_create",
          pricingComponentId: created.id,
          componentType: created.componentType,
          currency: created.currency,
          amount: String(created.amount),
          actorId: actor?.id ?? null,
          actorRole: null,
        },
      },
    ]);

    return created;
  });
}

function decimalToNumber(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const asString =
    typeof (value as { toString?: () => string }).toString === "function"
      ? (value as { toString: () => string }).toString()
      : "";
  const parsed = Number(asString);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundTo2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function toMinorUnits(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100);
}

function toMajorUnits(minor: number): number {
  return roundTo2(minor / 100);
}

function buildSystemLegTemplates(serviceType: ServiceType | null | undefined): SystemLegTemplate[] {
  const pickup: SystemLegTemplate = {
    kind: "pickup",
    sequence: 1,
    mode: TransportMode.road,
    componentType: PricingComponentType.handling,
    description: "Pickup leg service charge allocation",
  };
  const linehaul: SystemLegTemplate = {
    kind: "linehaul",
    sequence: 2,
    mode: TransportMode.road,
    componentType: PricingComponentType.linehaul,
    description: "Linehaul leg service charge allocation",
  };
  const lastMile: SystemLegTemplate = {
    kind: "last_mile",
    sequence: 3,
    mode: TransportMode.road,
    componentType: PricingComponentType.local_delivery,
    description: "Last-mile leg service charge allocation",
  };

  if (serviceType === ServiceType.DOOR_TO_POINT) {
    return [pickup, { ...linehaul, sequence: 2 }];
  }
  if (serviceType === ServiceType.POINT_TO_DOOR) {
    return [{ ...linehaul, sequence: 1 }, { ...lastMile, sequence: 2 }];
  }
  if (serviceType === ServiceType.POINT_TO_POINT) {
    return [{ ...linehaul, sequence: 1 }];
  }
  return [pickup, linehaul, lastMile];
}

function weightForLegKind(kind: SystemLegKind): number {
  if (kind === "pickup") return 0.2;
  if (kind === "linehaul") return 0.5;
  return 0.3;
}

function splitMinorByWeights(totalMinor: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const safeWeights = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const sum = safeWeights.reduce((acc, w) => acc + w, 0);
  if (sum <= 0) {
    const base = Math.floor(totalMinor / weights.length);
    const remainder = totalMinor - base * weights.length;
    return weights.map((_, idx) => base + (idx < remainder ? 1 : 0));
  }

  const raw = safeWeights.map((w) => (totalMinor * w) / sum);
  const floors = raw.map((v) => Math.floor(v));
  let remainder = totalMinor - floors.reduce((acc, v) => acc + v, 0);

  const fractions = raw
    .map((v, idx) => ({ idx, frac: v - floors[idx] }))
    .sort((a, b) => b.frac - a.frac);

  for (let i = 0; i < fractions.length && remainder > 0; i += 1) {
    floors[fractions[i].idx] += 1;
    remainder -= 1;
  }
  return floors;
}

export async function seedInitialServiceChargePricing(
  orderId: string,
  input: {
    serviceCharge?: number | null;
    currency?: string | null;
    serviceType?: ServiceType | null;
    perLegRuleAmountsMajor?: number[] | null;
  },
  actor?: Actor,
) {
  await ensureOrderExists(orderId);

  const amount = Number(input.serviceCharge ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const normalizedCurrency = String(input.currency ?? "")
    .trim()
    .toUpperCase();
  if (!normalizedCurrency || !SUPPORTED_CURRENCY_CODES.has(normalizedCurrency)) {
    throw orderError("currency must be one of: UZS, USD, CNY", 400);
  }

  return prisma.$transaction(async (tx) => {
    let legs = await tx.orderLeg.findMany({
      where: { orderId },
      orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        sequence: true,
        metadata: true,
      },
    });

    const templates = buildSystemLegTemplates(input.serviceType);

    if (legs.length === 0) {
      const created = await Promise.all(
        templates.map((template) =>
          tx.orderLeg.create({
            data: {
              orderId,
              sequence: template.sequence,
              mode: template.mode,
              status: OrderLegStatus.planned,
              notes: `System leg: ${template.kind}`,
              metadata: {
                systemGenerated: true,
                legKind: template.kind,
              },
            },
            select: { id: true, sequence: true, metadata: true },
          }),
        ),
      );
      legs = created.sort((a, b) => a.sequence - b.sequence);
    }

    const kindBySequence = new Map<number, SystemLegTemplate>(
      templates.map((template) => [template.sequence, template]),
    );

    const selectedLegs = legs
      .map((leg) => {
        const template = kindBySequence.get(leg.sequence);
        if (!template) return null;
        return { leg, template };
      })
      .filter((value): value is { leg: (typeof legs)[number]; template: SystemLegTemplate } => Boolean(value));

    if (selectedLegs.length === 0) {
      throw orderError("Unable to map order legs for pricing component generation", 400);
    }

    const totalMinor = toMinorUnits(amount);
    const candidateRuleAmounts = Array.isArray(input.perLegRuleAmountsMajor)
      ? input.perLegRuleAmountsMajor
      : [];
    const canUseRuleAmounts =
      candidateRuleAmounts.length === selectedLegs.length &&
      candidateRuleAmounts.every((value) => Number.isFinite(value) && value > 0);
    const weights = canUseRuleAmounts
      ? candidateRuleAmounts
      : selectedLegs.map((entry) => weightForLegKind(entry.template.kind));
    const splitMinor = splitMinorByWeights(totalMinor, weights);

    const pricingComponents = [];
    for (let i = 0; i < selectedLegs.length; i += 1) {
      const entry = selectedLegs[i];
      const legAmountMajor = toMajorUnits(splitMinor[i] ?? 0);
      const refKey = `${SERVICE_CHARGE_REF_KEY_PREFIX}${entry.leg.id}`;

      const existing = await tx.pricingComponent.findFirst({
        where: {
          orderId,
          referenceKey: refKey,
          source: PricingComponentSource.rule,
        },
        select: { id: true },
      });

      const component = existing
        ? await tx.pricingComponent.update({
            where: { id: existing.id },
            data: {
              orderLegId: entry.leg.id,
              componentType: entry.template.componentType,
              source: PricingComponentSource.rule,
              description: entry.template.description,
              amount: legAmountMajor,
              currency: normalizedCurrency,
              referenceKey: refKey,
            },
          })
        : await tx.pricingComponent.create({
            data: {
              orderId,
              orderLegId: entry.leg.id,
              componentType: entry.template.componentType,
              source: PricingComponentSource.rule,
              description: entry.template.description,
              amount: legAmountMajor,
              currency: normalizedCurrency,
              referenceKey: refKey,
            },
          });
      pricingComponents.push(component);
    }

    await enqueueCargoPilotDomainEventsTx(tx, [
      {
        type: "order_status_changed",
        tenantScope: resolveActorTenantScope(actor),
        entityId: orderId,
        payload: {
          source: "pricing_component_seed",
          pricingComponentIds: pricingComponents.map((item) => item.id),
          actorId: actor?.id ?? null,
          actorRole: null,
        },
      },
    ]);

    return pricingComponents;
  });
}

export async function resolvePayableTotalFromPricing(orderId: string) {
  await ensureOrderExists(orderId);

  const items = await prisma.pricingComponent.findMany({
    where: { orderId },
    select: {
      amount: true,
      currency: true,
      baseAmount: true,
      baseCurrency: true,
    },
  });

  if (items.length === 0) {
    return null;
  }

  const originalCurrencies = new Set<string>();
  const baseCurrencies = new Set<string>();
  let originalTotal = 0;
  let baseTotal = 0;
  let hasBaseForAll = true;

  for (const item of items) {
    const originalCurrency = String(item.currency ?? "")
      .trim()
      .toUpperCase();
    if (!SUPPORTED_CURRENCY_CODES.has(originalCurrency)) {
      throw orderError("Pricing component currency is not supported", 400);
    }
    originalCurrencies.add(originalCurrency);
    originalTotal += decimalToNumber(item.amount);

    const baseCurrency = String(item.baseCurrency ?? "")
      .trim()
      .toUpperCase();
    if (!item.baseAmount || !baseCurrency) {
      hasBaseForAll = false;
      continue;
    }
    if (!SUPPORTED_CURRENCY_CODES.has(baseCurrency)) {
      throw orderError("Pricing component baseCurrency is not supported", 400);
    }
    baseCurrencies.add(baseCurrency);
    baseTotal += decimalToNumber(item.baseAmount);
  }

  if (originalCurrencies.size === 1) {
    const currency = Array.from(originalCurrencies)[0];
    const amountMajor = roundTo2(originalTotal);
    if (amountMajor <= 0) {
      throw orderError("Calculated payable amount must be greater than zero", 400);
    }
    return {
      amountMajor,
      currency,
      source: "original" as const,
      componentCount: items.length,
    };
  }

  if (hasBaseForAll && baseCurrencies.size === 1) {
    const currency = Array.from(baseCurrencies)[0];
    const amountMajor = roundTo2(baseTotal);
    if (amountMajor <= 0) {
      throw orderError("Calculated payable amount must be greater than zero", 400);
    }
    return {
      amountMajor,
      currency,
      source: "base" as const,
      componentCount: items.length,
    };
  }

  throw orderError(
    "Pricing components use mixed currencies without a single base currency snapshot",
    400,
  );
}
