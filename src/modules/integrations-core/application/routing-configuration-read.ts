import {Prisma} from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type {AppUser} from "../../../types/app-user";
import {integrationProviderContext} from "./provider-access";
import {authorityError} from "../../orders-core/domain/creation-authority";
type Request={user:AppUser;resourceId:string;cursor?:string;limit?:number};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const select={id:true,revision:true,acceptedAt:true,isActive:true,priority:true} as const;
export const listTemplateConfigurationsForActor=(args:Request)=>read(args,"template");
export const listRoutingConfigurationsForActor=(args:Request)=>read(args,"routing");
/** Only the two explicit readonly resources share pagination; there is no service/worker bypass. */
async function read(args:Request,kind:"template"|"routing"){
 const context=await integrationProviderContext(args.user,"integration.routing.read");
 if(Object.keys(args).some(k=>!["user","resourceId","cursor","limit"].includes(k)) || !uuid.test(args.resourceId) ||
 (args.cursor!==undefined && !uuid.test(args.cursor)) || (args.limit!==undefined && (!Number.isSafeInteger(args.limit)||args.limit<1||args.limit>100)))
 throw authorityError("Invalid configuration history request",400);
 const resourceId=args.resourceId.toLowerCase(),limit=args.limit??25;
 return prisma.$transaction(async tx=>{
  await tx.$executeRaw`SET TRANSACTION READ ONLY`;await tx.$executeRaw`SET LOCAL statement_timeout = '3000ms'`;await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
  const parentSelect={id:true,configurationRevision:true,currentConfigurationId:true} as const;
  const parent=kind==="template"?await tx.routeTemplate.findFirst({where:{...context,id:resourceId},select:parentSelect}):await tx.carrierRoutingRule.findFirst({where:{...context,id:resourceId},select:parentSelect});
  if(!parent)throw authorityError("Configuration resource not found",404);
  const owner={tenantId:context.company.is.tenantId,companyId:context.companyId};
  const templateWhere={...owner,templateId:resourceId,template:{is:{...context,id:resourceId}}};
  const ruleWhere={...owner,ruleId:resourceId,rule:{is:{...context,id:resourceId}}};
  const cursor=args.cursor?(kind==="template"?await tx.routeTemplateConfigurationVersion.findFirst({where:{...templateWhere,id:args.cursor.toLowerCase()},select:{revision:true}}):await tx.carrierRoutingConfigurationVersion.findFirst({where:{...ruleWhere,id:args.cursor.toLowerCase()},select:{revision:true}})):null;
  if(args.cursor && !cursor)throw authorityError("Configuration history cursor not found",404);
  const page={...(cursor?{revision:{lt:cursor.revision}}:{})};
  const rows=kind==="template"?await tx.routeTemplateConfigurationVersion.findMany({where:{...templateWhere,...page},take:limit+1,orderBy:{revision:"desc"},select}):await tx.carrierRoutingConfigurationVersion.findMany({where:{...ruleWhere,...page},take:limit+1,orderBy:{revision:"desc"},select});
  const data=rows.slice(0,limit).map(row=>({id:row.id,revision:row.revision,acceptedAt:row.acceptedAt.toISOString(),isActive:row.isActive,priority:row.priority}));
  const total=kind==="template"?await tx.routeTemplateConfigurationVersion.count({where:templateWhere}):await tx.carrierRoutingConfigurationVersion.count({where:ruleWhere});
  return {resourceId,currentRevision:parent.configurationRevision,currentConfigurationId:parent.currentConfigurationId,data,total,
   pageInfo:{limit,hasNextPage:rows.length>limit,nextCursor:rows.length>limit?data[data.length-1]?.id??null:null}};
 },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead,maxWait:2000,timeout:5000});
}
