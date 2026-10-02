import {createHash} from "crypto";
import prisma from "../../../config/prismaClient";
import type {AppUser} from "../../../types/app-user";
import {requireTenantBoundOrderCompanyAuthority,hasCompanyScope} from "../../orders-core/domain/company-authority";
import {authorityError} from "../../orders-core/domain/creation-authority";
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function conflict():never {throw authorityError("Routing publication intent conflicts or revision is stale",409);}
/** Snapshots existing rules only; no HTTP authoring, provider effects or worker reacceptance. */
export async function publishCarrierRoutingConfigurationForActor(args:{user:AppUser;ruleId:string;operationId:string;expectedRevision:number}){
 if(Object.keys(args).some(k=>!["user","ruleId","operationId","expectedRevision"].includes(k)) || !uuid.test(args.ruleId) || !uuid.test(args.operationId) ||
 !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision<0 || args.expectedRevision>=2147483647)throw authorityError("Invalid routing publication intent",400);
 const ruleId=args.ruleId.toLowerCase(),operationId=args.operationId.toLowerCase(),intentSha256=createHash("sha256").update(JSON.stringify([ruleId,args.expectedRevision])).digest("hex");
 return prisma.$transaction(async tx=>{
  await tx.$executeRaw`SET LOCAL statement_timeout = '3000ms'`;await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
  const m=await requireTenantBoundOrderCompanyAuthority(tx,args.user,"integration.routing.manage");
  if(!hasCompanyScope(m))throw authorityError("Explicit company scope required",403);
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${m.tenantId! + ":routing:" + operationId},0))`;
  const owner={companyId:m.companyId,company:{is:{tenantId:m.tenantId!,type:"company" as const,isActive:true,tenant:{is:{status:"active" as const}}}}};
  if(!await tx.carrierRoutingRule.findFirst({where:{...owner,id:ruleId},select:{id:true}}))throw authorityError("Routing rule not found",404);
  await tx.$queryRaw`SELECT "id" FROM "CarrierRoutingRule" WHERE "id"=${ruleId}::uuid AND "companyId"=${m.companyId}::uuid FOR UPDATE`;
  const r=await tx.carrierRoutingRule.findFirst({where:{...owner,id:ruleId},select:{id:true,companyId:true,configurationRevision:true,currentConfigurationId:true,providerId:true,fallbackProviderId:true,routeTemplateId:true,routeTemplateLegId:true,name:true,code:true,isActive:true,priority:true,autoBook:true,serviceType:true,transportMode:true,originCountryCode:true,destinationCountryCode:true,minWeightKg:true,maxWeightKg:true,legSequence:true,conditionsJson:true}});
  if(!r)throw authorityError("Routing ownership changed",403);
  const receipt=await tx.carrierRoutingConfigurationVersion.findUnique({where:{tenantId_operationId:{tenantId:m.tenantId!,operationId}},select:{id:true,ruleId:true,companyId:true,actorUserId:true,companyMembershipId:true,tenantMembershipId:true,intentSha256:true,revision:true,operationId:true,acceptedAt:true}});
  if(receipt){
   if(receipt.intentSha256!==intentSha256 || receipt.ruleId!==ruleId || receipt.companyId!==m.companyId || receipt.actorUserId!==args.user.id ||
   receipt.companyMembershipId!==args.user.companyMembershipId || receipt.tenantMembershipId!==m.tenantMembershipId || receipt.revision>r.configurationRevision ||
   (receipt.revision===r.configurationRevision && receipt.id!==r.currentConfigurationId))conflict();
   return result(receipt);
  }
  if(r.configurationRevision!==args.expectedRevision)conflict();
  if(r.conditionsJson!==null)throw authorityError("Typed routing conditions require an approved contract",409);
  if([r.name,r.code,r.originCountryCode,r.destinationCountryCode].some(v=>v!==null && Buffer.byteLength(v,"utf8")>2048) ||
    (r.minWeightKg && r.minWeightKg.isNegative()) || (r.maxWeightKg && r.maxWeightKg.isNegative()) ||
    (r.minWeightKg && r.maxWeightKg && r.minWeightKg.greaterThan(r.maxWeightKg)))throw authorityError("Invalid bounded routing snapshot",409);
  // Lock authoritative referenced configuration before reading its current pointer.
  for(const id of [...new Set([r.providerId,...(r.fallbackProviderId?[r.fallbackProviderId]:[])])].sort())
    await tx.$queryRaw`SELECT "id" FROM "IntegrationProvider" WHERE "id"=${id}::uuid AND "companyId"=${m.companyId}::uuid FOR SHARE`;
  const providerSelect={id:true,companyId:true,configurationRevision:true,currentConfigurationId:true,currentConfiguration:{select:{id:true,providerId:true,companyId:true,revision:true,domain:true,status:true}}} as const;
  const loadProvider=async(id:string)=>{
   const p=await tx.integrationProvider.findFirst({where:{...owner,id,domain:"carrier",status:"active"},select:providerSelect});
   if(!p?.currentConfigurationId || !p.currentConfiguration || p.currentConfiguration.id!==p.currentConfigurationId ||
    p.currentConfiguration.providerId!==id || p.currentConfiguration.companyId!==m.companyId || p.currentConfiguration.revision!==p.configurationRevision ||
    p.currentConfiguration.domain!=="carrier" || p.currentConfiguration.status!=="active")throw authorityError("Accepted owned carrier configuration required",409);
   return p;
  };
  const primary=await loadProvider(r.providerId),fallback=r.fallbackProviderId?await loadProvider(r.fallbackProviderId):null;
  let templateVersionId:string|null=null,templateRevision:number|null=null;
  if(r.routeTemplateId){
   await tx.$queryRaw`SELECT "id" FROM "RouteTemplate" WHERE "id"=${r.routeTemplateId}::uuid AND "companyId"=${m.companyId}::uuid FOR SHARE`;
   const template=await tx.routeTemplate.findFirst({where:{...owner,id:r.routeTemplateId,isActive:true},select:{id:true,configurationRevision:true,currentConfigurationId:true}});
   if(!template?.currentConfigurationId || template.configurationRevision<1)throw authorityError("Accepted owned template configuration required",409);
   templateVersionId=template.currentConfigurationId;templateRevision=template.configurationRevision;
   if(r.routeTemplateLegId && !await tx.routeTemplateConfigurationLeg.findFirst({where:{versionId:templateVersionId,templateId:r.routeTemplateId,sourceLegId:r.routeTemplateLegId},select:{sourceLegId:true}}))throw authorityError("Accepted template child required",409);
  }else if(r.routeTemplateLegId)throw authorityError("Routing template child is unbound",409);
  const version=await tx.carrierRoutingConfigurationVersion.create({data:{
   tenantId:m.tenantId!,companyId:m.companyId,ruleId,actorUserId:args.user.id,companyMembershipId:args.user.companyMembershipId!,tenantMembershipId:m.tenantMembershipId!,
   operationId,intentSha256,expectedRevision:args.expectedRevision,revision:args.expectedRevision+1,
   providerId:r.providerId,providerVersionId:primary.currentConfigurationId!,providerRevision:primary.configurationRevision,
   fallbackProviderId:r.fallbackProviderId,fallbackVersionId:fallback?.currentConfigurationId??null,fallbackRevision:fallback?.configurationRevision??null,
   routeTemplateId:r.routeTemplateId,routeTemplateLegId:r.routeTemplateLegId,templateVersionId,templateRevision,
   name:r.name,code:r.code,isActive:r.isActive,priority:r.priority,autoBook:r.autoBook,serviceType:r.serviceType,transportMode:r.transportMode,originCountryCode:r.originCountryCode,destinationCountryCode:r.destinationCountryCode,minWeightKg:r.minWeightKg,maxWeightKg:r.maxWeightKg,legSequence:r.legSequence,
  },select:{id:true,ruleId:true,revision:true,operationId:true,acceptedAt:true}});
  const changed=await tx.carrierRoutingRule.updateMany({where:{...owner,id:ruleId,configurationRevision:args.expectedRevision,currentConfigurationId:r.currentConfigurationId},data:{configurationRevision:version.revision,currentConfigurationId:version.id,updatedByUserId:args.user.id}});
  if(changed.count!==1)conflict();return result(version);
 },{maxWait:2000,timeout:5000});
}
function result(r:{id:string;ruleId:string;revision:number;operationId:string;acceptedAt:Date}){return {id:r.id,ruleId:r.ruleId,revision:r.revision,operationId:r.operationId,acceptedAt:r.acceptedAt.toISOString()};}
