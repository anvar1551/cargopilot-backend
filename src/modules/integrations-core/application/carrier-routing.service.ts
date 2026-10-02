import { requireAuthorizedOrder } from "../../orders-core/domain/order-access";
import type { OrderActor } from "../../orders-core/shared/actor";
import { integrationProviderContext } from "./provider-access";
import { authorityError } from "../../orders-core/domain/creation-authority";
import { Prisma, ServiceType, TransportMode } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";

type AuthUser = AppUser;

const db = prisma as any;

type CarrierRoutingRuleInput = {
  companyId: string;
  name: string;
  code?: string | null;
  providerId: string;
  fallbackProviderId?: string | null;
  routeTemplateId?: string | null;
  routeTemplateLegId?: string | null;
  isActive?: boolean;
  priority?: number;
  autoBook?: boolean;
  serviceType?: ServiceType | null;
  transportMode?: TransportMode | null;
  originCountryCode?: string | null;
  destinationCountryCode?: string | null;
  minWeightKg?: number | null;
  maxWeightKg?: number | null;
  legSequence?: number | null;
  conditionsJson?: unknown;
};

type CarrierRoutingRuleFilters = {
  companyId?: string;
  providerId?: string;
  routeTemplateId?: string;
  isActive?: boolean;
  q?: string;
  cursor?: string;
  limit?: number;
};

export type ResolvedCarrierRoutingRule = {
  id: string;
  companyId: string;
  providerId: string;
  providerCode: string;
  providerEnvironment: string;
  fallbackProviderId: string | null;
  name: string;
  code: string | null;
  priority: number;
  autoBook: boolean;
};

function toIso(value: Date | string | null | undefined) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function normalizeCountryCode(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

function mapRuleRow(row: any) {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    code: row.code ?? null,
    providerId: row.providerId,
    providerCode: row.provider?.providerCode ?? null,
    providerEnvironment: row.provider?.environment ?? null,
    fallbackProviderId: row.fallbackProviderId ?? null,
    fallbackProviderCode: row.fallbackProvider?.providerCode ?? null,
    routeTemplateId: row.routeTemplateId ?? null,
    routeTemplateName: row.routeTemplate?.name ?? null,
    routeTemplateCode: row.routeTemplate?.code ?? null,
    routeTemplateLegId: row.routeTemplateLegId ?? null,
    routeTemplateLegCode: row.routeTemplateLeg?.legCode ?? null,
    routeTemplateLegSequence: row.routeTemplateLeg?.sequence ?? null,
    isActive: Boolean(row.isActive),
    priority: Number(row.priority ?? 0),
    autoBook: Boolean(row.autoBook),
    serviceType: row.serviceType ?? null,
    transportMode: row.transportMode ?? null,
    originCountryCode: row.originCountryCode ?? null,
    destinationCountryCode: row.destinationCountryCode ?? null,
    minWeightKg: row.minWeightKg == null ? null : Number(row.minWeightKg),
    maxWeightKg: row.maxWeightKg == null ? null : Number(row.maxWeightKg),
    legSequence: row.legSequence ?? null,
    conditionsJson: row.conditionsJson ?? null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export async function listCarrierRoutingRulesForActor(args: {
  user: AuthUser;
  filters?: CarrierRoutingRuleFilters;
}) {
  const filters = args.filters ?? {};
  const context = await integrationProviderContext(args.user, "integration.routing.read", filters.companyId);
  if (filters.limit !== undefined && (!Number.isSafeInteger(filters.limit) || filters.limit < 1 || filters.limit > 100))
    throw authorityError("Routing limit must be from 1 to 100", 400);
  if (filters.cursor !== undefined && (!filters.cursor?.trim() || filters.limit === undefined))
    throw authorityError("Routing cursor requires pagination", 400);
  if (filters.q !== undefined && (typeof filters.q !== "string" || filters.q.length > 180))
    throw authorityError("Routing search too long", 400);
  return prisma.$transaction(async tx => {
  await tx.$executeRaw`SET TRANSACTION READ ONLY`;
  await tx.$executeRaw`SET LOCAL statement_timeout = '3000ms'`;
  await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
  const q = filters.q?.trim(), limit = filters.limit ?? 100, paginated = filters.limit !== undefined;
  const provider = { is: { companyId: context.companyId, company: context.company, domain: "carrier" as const } };
  const baseWhere = { ...context, provider,
    ...(filters.providerId ? { providerId: filters.providerId } : {}),
    ...(filters.routeTemplateId ? { routeTemplateId: filters.routeTemplateId } : {}),
    ...(typeof filters.isActive === "boolean" ? { isActive: filters.isActive } : {}),
    AND: [
      { OR: [{ fallbackProviderId: null }, { fallbackProvider: provider }] },
      { OR: [{ routeTemplateId: null }, { routeTemplate: { is: context } }] },
      { OR: [{ routeTemplateLegId: null }, { routeTemplateLeg: { is: { routeTemplate: { is: context } } } }] },
      ...(q ? [{ OR: [{ name: { contains: q, mode: "insensitive" as const } }, { code: { contains: q, mode: "insensitive" as const } },
        { originCountryCode: { contains: q, mode: "insensitive" as const } }, { destinationCountryCode: { contains: q, mode: "insensitive" as const } },
        { provider: { is: { providerCode: { contains: q, mode: "insensitive" as const } } } },
        { routeTemplate: { is: { name: { contains: q, mode: "insensitive" as const } } } },
        { routeTemplate: { is: { code: { contains: q, mode: "insensitive" as const } } } }] }] : []),
    ],
  };
  // Prisma cannot compare this row's templateId with its leg's templateId in a
  // relation filter. Bound and assess the complete candidate set before counts.
  const candidates = await tx.carrierRoutingRule.findMany({where:baseWhere,take:101,select:{
    id:true,routeTemplateId:true,routeTemplateLegId:true,routeTemplateLeg:{select:{routeTemplateId:true}},
  }});
  if (candidates.length > 100) throw Object.assign(authorityError("Narrow routing filters",409),{code:"INTEGRATION_READ_CAPACITY"});
  const eligibleIds = candidates.filter((row:any) => !row.routeTemplateId || !row.routeTemplateLegId ||
    row.routeTemplateLeg?.routeTemplateId === row.routeTemplateId).map((row:any) => row.id);
  const where = {AND:[baseWhere,{id:{in:eligibleIds}}]};
  if (filters.cursor && !await tx.carrierRoutingRule.findFirst({where:{AND:[where,{id:filters.cursor}]},select:{id:true}}))
    throw authorityError("Routing cursor not found",404);
  const rows = await tx.carrierRoutingRule.findMany({ where, select: {
    id:true,companyId:true,name:true,code:true,providerId:true,fallbackProviderId:true,routeTemplateId:true,routeTemplateLegId:true,
    isActive:true,priority:true,autoBook:true,serviceType:true,transportMode:true,originCountryCode:true,destinationCountryCode:true,
    minWeightKg:true,maxWeightKg:true,legSequence:true,createdAt:true,updatedAt:true,
    provider:{select:{providerCode:true,environment:true}},fallbackProvider:{select:{providerCode:true,environment:true}},
    routeTemplate:{select:{name:true,code:true}},routeTemplateLeg:{select:{routeTemplateId:true,legCode:true,sequence:true}},
  }, orderBy:[{priority:"desc"},{createdAt:"asc"},{id:"asc"}], take: paginated ? limit+1 : limit,
    ...(filters.cursor ? {cursor:{id:filters.cursor},skip:1} : {}) });
  // Same-company equality is not proof that a selected template leg belongs to the selected template.
  if (rows.some((row:any) => row.routeTemplateId && row.routeTemplateLegId && row.routeTemplateLeg?.routeTemplateId !== row.routeTemplateId))
    throw authorityError("Routing configuration references conflict",409);
  const mapped = rows.slice(0,limit).map((row:any) => mapRuleRow({...row,conditionsJson:null}));
  if (!paginated) return mapped;
  const total = await tx.carrierRoutingRule.count({where});
  return {data:mapped,total,pageInfo:{limit,hasNextPage:rows.length>limit,nextCursor:rows.length>limit?mapped[mapped.length-1]?.id??null:null}};
  }, {isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead,maxWait:2000,timeout:5000});
}

function routingMutationUnavailable(): never {
  throw Object.assign(authorityError("Controlled routing configuration workflow required",409),
    {code:"INTEGRATION_ROUTING_CONFIGURATION_WORKFLOW_REQUIRED"});
}
async function requireOwnedRoutingMutation(user: AuthUser, ruleId: string) {
  const context = await integrationProviderContext(user,"integration.routing.manage");
  if (!await db.carrierRoutingRule.findFirst({where:{...context,id:ruleId},select:{id:true}}))
    throw authorityError("Routing rule not found",404);
}
export async function createCarrierRoutingRuleForActor(args:{user:AuthUser;input:CarrierRoutingRuleInput}) {
  await integrationProviderContext(args.user,"integration.routing.manage",args.input.companyId);
  routingMutationUnavailable();
}
export async function updateCarrierRoutingRuleForActor(args:{user:AuthUser;ruleId:string;input:Partial<CarrierRoutingRuleInput>}) {
  await requireOwnedRoutingMutation(args.user,args.ruleId);
  routingMutationUnavailable();
}
export async function deleteCarrierRoutingRuleForActor(args:{user:AuthUser;ruleId:string}) {
  await requireOwnedRoutingMutation(args.user,args.ruleId);
  routingMutationUnavailable();
}

function resolveLegOriginCountry(leg: any) {
  return (
    normalizeCountryCode(leg.fromCountry) ||
    normalizeCountryCode(leg.order?.senderAddressObj?.country)
  );
}

function resolveLegDestinationCountry(leg: any) {
  return (
    normalizeCountryCode(leg.toCountry) ||
    normalizeCountryCode(leg.order?.receiverAddressObj?.country)
  );
}

export async function resolveCarrierRoutingRuleForOrderLeg(args: {
  actor: OrderActor | null | undefined;
  orderId: string;
  legId: string;
}): Promise<ResolvedCarrierRoutingRule | null> {
  const authorized = await requireAuthorizedOrder(args.actor,args.orderId,"shipment.bookCarrier");
  const companyId=args.actor!.companyId!,tenantId=authorized.tenantId;
  if(!authorized.ownerOrgId || authorized.ownerOrgId!==companyId) throw authorityError("Selected owning company required",403);
  return prisma.$transaction(async tx=>{
  await tx.$executeRaw`SET TRANSACTION READ ONLY`;
  await tx.$executeRaw`SET LOCAL statement_timeout = '3000ms'`;
  await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
  const company={is:{id:companyId,tenantId,type:"company" as const,isActive:true,tenant:{is:{status:"active" as const}}}};
  const template={is:{companyId,company,isActive:true}};

  const leg = await tx.orderLeg.findFirst({
    where: {id:args.legId,orderId:args.orderId,order:{is:{id:args.orderId,tenantId,ownerOrgId:companyId,ownerOrg:company,
      AND:[{OR:[{senderAddressId:null},{senderAddressObj:{is:{tenantId}}}]},{OR:[{receiverAddressId:null},{receiverAddressObj:{is:{tenantId}}}]}]}},
      AND:[{OR:[{routeTemplateId:null},{routeTemplate:template}]},{OR:[{routeTemplateLegId:null},{routeTemplateLeg:{is:{routeTemplate:template}}}]}]},
    select: {
      id:true,orderId:true,templateCompanyId:true,mode:true,sequence:true,fromCountry:true,toCountry:true,routeTemplateId:true,routeTemplateLegId:true,
      routeTemplateLeg:{select:{routeTemplateId:true}},
      order: {
        select: {
          id: true,
          tenantId: true,
          serviceType: true,
          weightKg: true,
          ownerOrgId: true,
          assignedOrgId: true,
          senderAddressObj: { select: { country: true } },
          receiverAddressObj: { select: { country: true } },
        },
      },
    },
  });
  if (!leg) return null;
  if(leg.order.tenantId!==tenantId || leg.order.ownerOrgId!==companyId || leg.orderId!==args.orderId) return null;
  if((leg.templateCompanyId && !leg.routeTemplateId) || (leg.routeTemplateId && leg.templateCompanyId!==companyId)) return null;
  if(leg.routeTemplateLegId && (!leg.routeTemplateId || leg.routeTemplateLeg?.routeTemplateId!==leg.routeTemplateId)) return null;

  const originCountryCode = resolveLegOriginCountry(leg);
  const destinationCountryCode = resolveLegDestinationCountry(leg);
  const weightKg = Number(leg.order.weightKg ?? NaN);
  const hasWeight = Number.isFinite(weightKg) && weightKg > 0;

  const rows = await tx.carrierRoutingRule.findMany({
    where: {
      companyId,
      company,
      isActive: true,
      provider: {
        is:{companyId,company,domain:"carrier",status:"active"},
      },
      OR: [{ serviceType: null }, { serviceType: leg.order.serviceType }],
      AND: [
        {OR:[{fallbackProviderId:null},{fallbackProvider:{is:{companyId,company,domain:"carrier",status:"active"}}}]},
        {OR:[{routeTemplateId:null},{routeTemplate:template}]},
        {OR:[{routeTemplateLegId:null},{routeTemplateLeg:{is:{routeTemplate:template}}}]},
        { OR: [{ transportMode: null }, { transportMode: leg.mode }] },
        { OR: [{ legSequence: null }, { legSequence: leg.sequence }] },
        {
          OR: [
            { originCountryCode: null },
            ...(originCountryCode ? [{ originCountryCode }] : []),
          ],
        },
        {
          OR: [
            { destinationCountryCode: null },
            ...(destinationCountryCode ? [{ destinationCountryCode }] : []),
          ],
        },
        {
          OR: [
            { routeTemplateId: null },
            ...(leg.routeTemplateId ? [{ routeTemplateId: leg.routeTemplateId }] : []),
          ],
        },
        {
          OR: [
            { routeTemplateLegId: null },
            ...(leg.routeTemplateLegId ? [{ routeTemplateLegId: leg.routeTemplateLegId }] : []),
          ],
        },
        hasWeight ? { OR: [{ minWeightKg: null }, { minWeightKg: { lte: weightKg } }] } : { minWeightKg: null },
        hasWeight ? { OR: [{ maxWeightKg: null }, { maxWeightKg: { gte: weightKg } }] } : { maxWeightKg: null },
      ],
    },
    select: {
      id:true,companyId:true,providerId:true,fallbackProviderId:true,name:true,code:true,priority:true,autoBook:true,routeTemplateId:true,routeTemplateLegId:true,
      routeTemplateLeg:{select:{routeTemplateId:true}},
      provider: {
        select: {
          id: true,
          companyId:true,
          providerCode: true,
          environment: true,
        },
      },
    },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }, { id:"asc" }],
    take: 1,
  });

  const row = rows[0];
  if (!row) return null;
  if(row.companyId!==companyId || row.provider.companyId!==companyId || (row.routeTemplateLegId && (!row.routeTemplateId || row.routeTemplateLeg?.routeTemplateId!==row.routeTemplateId))) return null;
  return {
    id: row.id,
    companyId: row.companyId,
    providerId: row.providerId,
    providerCode: row.provider.providerCode,
    providerEnvironment: row.provider.environment,
    fallbackProviderId: row.fallbackProviderId ?? null,
    name: row.name,
    code: row.code ?? null,
    priority: Number(row.priority ?? 0),
    autoBook: Boolean(row.autoBook),
  };
  },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead,maxWait:2000,timeout:5000});
}
