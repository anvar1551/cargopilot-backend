import { requireAuthorizedOrder } from "../orders-core/domain/order-access";
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
  resolveActorTenantScope,
  type Actor,
  type CreatePricingComponentInput,
} from "./shared";

const SUPPORTED_CURRENCY_CODES = new Set(["UZS", "USD", "CNY"]);
const SERVICE_CHARGE_REF_KEY = "system:service_charge";
const SERVICE_CHARGE_REF_KEY_PREFIX = `${SERVICE_CHARGE_REF_KEY}:leg:`;

type SystemLegKind = "pickup" | "linehaul" | "last_mile" | "route_template";

type SystemLegTemplate = {
  kind: SystemLegKind;
  sequence: number;
  mode: TransportMode;
  routeTemplateId?: string | null;
  routeTemplateLegId?: string | null;
  legCode?: string | null;
  fromCountry?: string | null;
  toCountry?: string | null;
  componentType: PricingComponentType;
  description: string;
};

export async function listPricingComponents(orderId:string,actor?:Actor) {
  const order=await requireAuthorizedOrder(actor,orderId,"shipment.view");
  return prisma.$transaction(async tx=>{
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '3000ms'`;
    await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
    const rows=await tx.pricingComponent.findMany({where:{orderId,order:{is:{id:orderId,tenantId:order.tenantId}},OR:[{orderLegId:null},{orderLeg:{is:{orderId}}}]},take:101,
      orderBy:[{createdAt:"desc"},{id:"asc"}],select:{id:true,orderId:true,orderLegId:true,componentType:true,source:true,description:true,amount:true,currency:true,
        fxRateSnapshot:true,baseCurrency:true,baseAmount:true,referenceKey:true,createdAt:true,updatedAt:true}});
    if(rows.length>100)throw Object.assign(orderError("Narrow pricing component request",409),{code:"ORDER_PRICING_READ_CAPACITY"});
    return rows.map(row=>({...row,amount:row.amount.toString(),fxRateSnapshot:row.fxRateSnapshot?.toString()??null,baseAmount:row.baseAmount?.toString()??null}));
  },{isolationLevel:"RepeatableRead",maxWait:2000,timeout:5000});
}

function pricingAcceptanceRequired():never {
  throw Object.assign(orderError("Approved pricing and FX acceptance workflow required",409),{code:"ORDER_PRICING_ACCEPTANCE_REQUIRED"});
}
export async function createPricingComponent(orderId:string,_input:CreatePricingComponentInput,actor?:Actor) {
  await requireAuthorizedOrder(actor,orderId,"shipment.update");
  pricingAcceptanceRequired();
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

function buildSystemLegTemplates(
  serviceType: ServiceType | null | undefined,
  route?: {
    originCountryCode?: string | null;
    destinationCountryCode?: string | null;
    linehaulMode?: TransportMode | null;
  },
): SystemLegTemplate[] {
  const originCountry = route?.originCountryCode ?? null;
  const destinationCountry = route?.destinationCountryCode ?? null;
  const linehaulMode = route?.linehaulMode ?? TransportMode.road;
  const pickup: SystemLegTemplate = {
    kind: "pickup",
    sequence: 1,
    mode: TransportMode.road,
    fromCountry: originCountry,
    toCountry: originCountry,
    componentType: PricingComponentType.handling,
    description: "Pickup leg service charge allocation",
  };
  const linehaul: SystemLegTemplate = {
    kind: "linehaul",
    sequence: 2,
    mode: linehaulMode,
    fromCountry: originCountry,
    toCountry: destinationCountry,
    componentType: PricingComponentType.linehaul,
    description: "Linehaul leg service charge allocation",
  };
  const lastMile: SystemLegTemplate = {
    kind: "last_mile",
    sequence: 3,
    mode: TransportMode.road,
    fromCountry: destinationCountry,
    toCountry: destinationCountry,
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

function componentTypeForRouteTemplateLeg(leg: { legCode?: string | null; label?: string | null }) {
  const key = `${leg.legCode ?? ""} ${leg.label ?? ""}`.toLowerCase();
  if (key.includes("pickup")) return PricingComponentType.handling;
  if (key.includes("last") || key.includes("delivery")) {
    return PricingComponentType.local_delivery;
  }
  return PricingComponentType.linehaul;
}

async function loadRouteTemplateLegTemplates(
  tx: any,
  routeTemplateId: string | null | undefined,
  companyId: string,
  tenantId: string,
): Promise<SystemLegTemplate[] | null> {
  if (!routeTemplateId) return null;
  const routeTemplate = await tx.routeTemplate.findFirst({
    where: {
      id: routeTemplateId,
      companyId,
      company:{is:{id:companyId,tenantId,type:"company",isActive:true,tenant:{is:{status:"active"}}}},
      isActive: true,
    },
    select: {
      id:true,companyId:true,
      legs: {take:101,orderBy:[{sequence:"asc"},{id:"asc"}],select:{id:true,routeTemplateId:true,sequence:true,legCode:true,label:true,mode:true,originCountryCode:true,destinationCountryCode:true}},
    },
  });
  if (!routeTemplate) {
    throw orderError("routeTemplateId not found or inactive", 400);
  }
  if(routeTemplate.companyId!==companyId || routeTemplate.legs.length>100 || routeTemplate.legs.some((leg:any)=>leg.routeTemplateId!==routeTemplate.id))
    throw orderError("Route template ownership or resource limit is invalid",409);
  if (!Array.isArray(routeTemplate.legs) || routeTemplate.legs.length === 0) {
    throw orderError("route template has no legs", 400);
  }

  return routeTemplate.legs.map((leg: any): SystemLegTemplate => ({
    kind: "route_template",
    sequence: leg.sequence,
    mode: leg.mode,
    routeTemplateId: routeTemplate.id,
    routeTemplateLegId: leg.id,
    legCode: leg.legCode,
    fromCountry: leg.originCountryCode ?? null,
    toCountry: leg.destinationCountryCode ?? null,
    componentType: componentTypeForRouteTemplateLeg(leg),
    description: `Route leg ${leg.sequence}: ${leg.label || leg.legCode}`,
  }));
}

function weightForLegKind(kind: SystemLegKind): number {
  if (kind === "pickup") return 0.2;
  if (kind === "linehaul") return 0.5;
  if (kind === "route_template") return 1;
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
    originCountryCode?: string | null;
    destinationCountryCode?: string | null;
    linehaulMode?: TransportMode | null;
    routeTemplateId?: string | null;
  },
  actor?: Actor,
) {
  const authorized=await requireAuthorizedOrder(actor,orderId,"shipment.create");
  if(!actor?.companyId || authorized.ownerOrgId!==actor.companyId)throw orderError("Selected owning company required for pricing seed",403);
  const companyId=actor.companyId,tenantId=authorized.tenantId!;

  const amount = Number(input.serviceCharge ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const normalizedCurrency = String(input.currency ?? "")
    .trim()
    .toUpperCase();
  if (!normalizedCurrency || !SUPPORTED_CURRENCY_CODES.has(normalizedCurrency)) {
    throw orderError("currency must be one of: UZS, USD, CNY", 400);
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL statement_timeout = '3000ms'`;
    await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id"=${orderId}::uuid FOR UPDATE`;
    if(!await tx.order.findFirst({where:{id:orderId,tenantId,ownerOrgId:companyId,ownerOrg:{is:{id:companyId,tenantId,type:"company",isActive:true,tenant:{is:{status:"active"}}}}},select:{id:true}}))throw orderError("Order pricing ownership is inactive or inconsistent",403);
    let legs = await tx.orderLeg.findMany({
      where: { orderId },
      take:101,
      orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        sequence: true,
        metadata: true,
        templateCompanyId:true,routeTemplateId:true,routeTemplateLegId:true,
        routeTemplate:{select:{companyId:true,company:{select:{tenantId:true,isActive:true}}}},
        routeTemplateLeg:{select:{routeTemplateId:true}},
      },
    });

    if(legs.length>100 || legs.some(leg=>
      (leg.templateCompanyId && !leg.routeTemplateId) ||
      (leg.routeTemplateId && (leg.templateCompanyId!==companyId || leg.routeTemplateId!==input.routeTemplateId || leg.routeTemplate?.companyId!==companyId || leg.routeTemplate.company.tenantId!==tenantId || !leg.routeTemplate.company.isActive)) ||
      (leg.routeTemplateLegId && (!leg.routeTemplateId || leg.routeTemplateLeg?.routeTemplateId!==leg.routeTemplateId))))throw orderError("Existing order leg pricing references are inconsistent",409);
    const templates =
      (await loadRouteTemplateLegTemplates(tx,input.routeTemplateId??null,companyId,tenantId)) ??
      buildSystemLegTemplates(input.serviceType, {
        originCountryCode: input.originCountryCode ?? null,
        destinationCountryCode: input.destinationCountryCode ?? null,
        linehaulMode: input.linehaulMode ?? null,
      });

    if (legs.length === 0) {
      const created = await Promise.all(
        templates.map((template) =>
          tx.orderLeg.create({
            data: {
              orderId,
              sequence: template.sequence,
              mode: template.mode,
              status: OrderLegStatus.planned,
              templateCompanyId: template.routeTemplateId ? companyId : null,
              routeTemplateId: template.routeTemplateId ?? null,
              routeTemplateLegId: template.routeTemplateLegId ?? null,
              fromCountry: template.fromCountry ?? null,
              toCountry: template.toCountry ?? null,
              notes:
                template.kind === "route_template"
                  ? `Route template leg: ${template.legCode ?? template.sequence}`
                  : `System leg: ${template.kind}`,
              metadata: {
                systemGenerated: true,
                legKind: template.kind,
                ...(template.routeTemplateId
                  ? { routeTemplateId: template.routeTemplateId }
                  : {}),
                ...(template.routeTemplateLegId
                  ? { routeTemplateLegId: template.routeTemplateLegId }
                  : {}),
                ...(template.legCode ? { legCode: template.legCode } : {}),
              },
            },
            select: {id:true,sequence:true,metadata:true,templateCompanyId:true,routeTemplateId:true,routeTemplateLegId:true,routeTemplate:{select:{companyId:true,company:{select:{tenantId:true,isActive:true}}}},routeTemplateLeg:{select:{routeTemplateId:true}}},
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
            where: { id: existing.id, orderId },
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
  },{maxWait:2000,timeout:5000});
}

/** Legacy estimates are not an accepted exact-money/FX financial obligation. No current source caller. */
export async function resolvePayableTotalFromPricing(orderId:string,actor?:Actor) {
  await requireAuthorizedOrder(actor,orderId,"shipment.view");
  pricingAcceptanceRequired();
}
