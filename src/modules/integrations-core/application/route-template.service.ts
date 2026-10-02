import { Prisma, ServiceType, TransportMode } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import { integrationProviderContext } from "./provider-access";
import { authorityError } from "../../orders-core/domain/creation-authority";
import type { AppUser } from "../../../types/app-user";
type AuthUser = AppUser;
function toIso(value: Date | string | null | undefined) {
  if (!value) return null;
  return new Date(value).toISOString();
}
type RouteTemplateLegInput = {
  id?: string | null;
  sequence: number;
  legCode: string;
  label?: string | null;
  mode: TransportMode;
  originCountryCode?: string | null;
  destinationCountryCode?: string | null;
  metadata?: unknown;
};

type RouteTemplateInput = {
  companyId: string;
  name: string;
  code?: string | null;
  isActive?: boolean;
  priority?: number;
  serviceType?: ServiceType | null;
  transportMode?: TransportMode | null;
  originCountryCode?: string | null;
  destinationCountryCode?: string | null;
  metadata?: unknown;
  legs: RouteTemplateLegInput[];
};

type RouteTemplateFilters = {
  companyId?: string;
  isActive?: boolean;
  q?: string;
  cursor?: string;
  limit?: number;
};

function mapLegRow(row: any) {
  return {
    id: row.id,
    routeTemplateId: row.routeTemplateId,
    sequence: Number(row.sequence),
    legCode: row.legCode,
    label: row.label ?? null,
    mode: row.mode,
    originCountryCode: row.originCountryCode ?? null,
    destinationCountryCode: row.destinationCountryCode ?? null,
    metadata: null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function mapTemplateRow(row: any) {
  return {
    id: row.id,
    companyId: row.companyId,
    company: row.company
      ? {
          id: row.company.id,
          name: row.company.name,
          code: row.company.code ?? null,
          type: row.company.type,
        }
      : null,
    name: row.name,
    code: row.code ?? null,
    isActive: Boolean(row.isActive),
    priority: Number(row.priority ?? 0),
    serviceType: row.serviceType ?? null,
    transportMode: row.transportMode ?? null,
    originCountryCode: row.originCountryCode ?? null,
    destinationCountryCode: row.destinationCountryCode ?? null,
    metadata: null,
    legs: Array.isArray(row.legs) ? row.legs.map(mapLegRow) : undefined,
    legCount: row._count?.legs ?? (Array.isArray(row.legs) ? row.legs.length : undefined),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}


const templateSelect = {
  id:true,companyId:true,name:true,code:true,isActive:true,priority:true,serviceType:true,transportMode:true,
  originCountryCode:true,destinationCountryCode:true,createdAt:true,updatedAt:true,
  company:{select:{id:true,name:true,code:true,type:true}},
  legs:{take:101,orderBy:[{sequence:"asc"},{id:"asc"}],select:{id:true,routeTemplateId:true,sequence:true,legCode:true,
    label:true,mode:true,originCountryCode:true,destinationCountryCode:true,createdAt:true,updatedAt:true}},
} satisfies Prisma.RouteTemplateSelect;
function capacity(): never {throw Object.assign(authorityError("Narrow route template request",409),{code:"INTEGRATION_READ_CAPACITY"});}
function safeTemplate(row: Prisma.RouteTemplateGetPayload<{select:typeof templateSelect}>) {
  if(row.legs.length>100 || row.legs.some(leg=>leg.routeTemplateId!==row.id)) capacity();
  return mapTemplateRow(row);
}
async function readSnapshot<T>(work:(tx:Prisma.TransactionClient)=>Promise<T>) {
  return prisma.$transaction(async tx=>{
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '3000ms'`;
    await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
    return work(tx);
  },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead,maxWait:2000,timeout:5000});
}
export async function listRouteTemplatesForActor(args:{user:AuthUser;filters?:RouteTemplateFilters}) {
  const filters=args.filters??{};
  const context=await integrationProviderContext(args.user,"integration.routing.read",filters.companyId);
  if(filters.limit!==undefined && (!Number.isSafeInteger(filters.limit)||filters.limit<1||filters.limit>100))
    throw authorityError("Invalid route template limit",400);
  if(filters.cursor!==undefined && (!filters.cursor?.trim()||filters.limit===undefined))
    throw authorityError("Template cursor requires pagination",400);
  if(filters.q!==undefined && (typeof filters.q!=="string"||filters.q.length>180))
    throw authorityError("Invalid route template search",400);
  const q=filters.q?.trim(),limit=filters.limit??100,paginated=filters.limit!==undefined;
  const where:Prisma.RouteTemplateWhereInput={...context,
    ...(typeof filters.isActive==="boolean"?{isActive:filters.isActive}:{}),
    ...(q?{OR:[{name:{contains:q,mode:"insensitive"}},{code:{contains:q,mode:"insensitive"}},
      {originCountryCode:{contains:q,mode:"insensitive"}},{destinationCountryCode:{contains:q,mode:"insensitive"}}]}:{})};
  return readSnapshot(async tx=>{
    if(filters.cursor && !await tx.routeTemplate.findFirst({where:{AND:[where,{id:filters.cursor}]},select:{id:true}}))
      throw authorityError("Route template cursor not found",404);
    const rows=await tx.routeTemplate.findMany({where,select:templateSelect,take:paginated?limit+1:limit,
      orderBy:[{priority:"desc"},{createdAt:"asc"},{id:"asc"}],...(filters.cursor?{cursor:{id:filters.cursor},skip:1}:{})});
    const data=rows.slice(0,limit).map(safeTemplate);
    if(!paginated)return data;
    const total=await tx.routeTemplate.count({where});
    return {data,total,pageInfo:{limit,hasNextPage:rows.length>limit,nextCursor:rows.length>limit?data[data.length-1]?.id??null:null}};
  });
}
export async function getRouteTemplateForActor(args:{user:AuthUser;routeTemplateId:string}) {
  const context=await integrationProviderContext(args.user,"integration.routing.read");
  return readSnapshot(async tx=>{
    const row=await tx.routeTemplate.findFirst({where:{...context,id:args.routeTemplateId},select:templateSelect});
    if(!row)throw authorityError("Route template not found",404);
    return safeTemplate(row);
  });
}
function mutationUnavailable():never {
  throw Object.assign(authorityError("Controlled route template workflow required",409),{code:"INTEGRATION_ROUTING_CONFIGURATION_WORKFLOW_REQUIRED"});
}
async function requireOwnedMutation(user:AuthUser,id:string) {
  const context=await integrationProviderContext(user,"integration.routing.manage");
  if(!await prisma.routeTemplate.findFirst({where:{...context,id},select:{id:true}}))throw authorityError("Route template not found",404);
}
export async function createRouteTemplateForActor(args:{user:AuthUser;input:RouteTemplateInput}) {
  await integrationProviderContext(args.user,"integration.routing.manage",args.input.companyId);mutationUnavailable();
}
export async function updateRouteTemplateForActor(args:{user:AuthUser;routeTemplateId:string;input:Partial<RouteTemplateInput>}) {
  await requireOwnedMutation(args.user,args.routeTemplateId);mutationUnavailable();
}
export async function deleteRouteTemplateForActor(args:{user:AuthUser;routeTemplateId:string}) {
  await requireOwnedMutation(args.user,args.routeTemplateId);mutationUnavailable();
}
