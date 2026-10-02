import { createHash } from "crypto";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import { requireTenantBoundOrderCompanyAuthority, hasCompanyScope } from "../../orders-core/domain/company-authority";
import { authorityError } from "../../orders-core/domain/creation-authority";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function conflict(): never { throw authorityError("Template publication intent conflicts or revision is stale", 409); }
/** Backend-only snapshot of existing authoritative configuration. No authoring, retirement or worker reacceptance. */
export async function publishRouteTemplateConfigurationForActor(args: {
  user: AppUser; templateId: string; operationId: string; expectedRevision: number;
}) {
  if (Object.keys(args).some(k => !["user","templateId","operationId","expectedRevision"].includes(k)) ||
      !uuid.test(args.templateId) || !uuid.test(args.operationId) ||
      !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0 || args.expectedRevision >= 2147483647)
    throw authorityError("Invalid template publication intent", 400);
  const templateId = args.templateId.toLowerCase(), operationId = args.operationId.toLowerCase();
  const intentSha256 = createHash("sha256").update(JSON.stringify([templateId,args.expectedRevision])).digest("hex");
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL statement_timeout = '3000ms'`;
    await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
    const membership = await requireTenantBoundOrderCompanyAuthority(tx,args.user,"integration.routing.manage");
    if (!hasCompanyScope(membership)) throw authorityError("Explicit company scope required",403);
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${membership.tenantId! + ":template:" + operationId},0))`;
    const owner = { companyId:membership.companyId, company:{is:{tenantId:membership.tenantId!,isActive:true,type:"company" as const,tenant:{is:{status:"active" as const}}}} };
    if (!await tx.routeTemplate.findFirst({where:{...owner,id:templateId},select:{id:true}})) throw authorityError("Template not found",404);
    await tx.$queryRaw`SELECT "id" FROM "RouteTemplate" WHERE "id"=${templateId}::uuid AND "companyId"=${membership.companyId}::uuid FOR UPDATE`;
    const template = await tx.routeTemplate.findFirst({where:{...owner,id:templateId},select:{
      id:true,companyId:true,configurationRevision:true,currentConfigurationId:true,
      name:true,code:true,isActive:true,priority:true,serviceType:true,transportMode:true,originCountryCode:true,destinationCountryCode:true,
      legs:{take:101,orderBy:[{sequence:"asc"},{id:"asc"}],select:{id:true,routeTemplateId:true,sequence:true,legCode:true,label:true,mode:true,originCountryCode:true,destinationCountryCode:true}},
    }});
    if (!template) throw authorityError("Template ownership changed",403);
    const receipt = await tx.routeTemplateConfigurationVersion.findUnique({where:{tenantId_operationId:{tenantId:membership.tenantId!,operationId}},select:{
      id:true,templateId:true,companyId:true,actorUserId:true,companyMembershipId:true,tenantMembershipId:true,
      intentSha256:true,revision:true,operationId:true,acceptedAt:true,
    }});
    if (receipt) {
      if (receipt.intentSha256!==intentSha256 || receipt.templateId!==templateId || receipt.companyId!==membership.companyId ||
          receipt.actorUserId!==args.user.id || receipt.companyMembershipId!==args.user.companyMembershipId || receipt.tenantMembershipId!==membership.tenantMembershipId ||
          receipt.revision>template.configurationRevision || (receipt.revision===template.configurationRevision && receipt.id!==template.currentConfigurationId)) conflict();
      return result(receipt);
    }
    if (template.configurationRevision!==args.expectedRevision) conflict();
    if (template.legs.length>100 || template.legs.some(l=>l.routeTemplateId!==templateId))
      throw authorityError("Template children require bounded consistent ownership",409);
    const texts = [template.name,template.code,template.originCountryCode,template.destinationCountryCode,
      ...template.legs.flatMap(l=>[l.legCode,l.label,l.originCountryCode,l.destinationCountryCode])];
    if (texts.some(value=>value!==null && Buffer.byteLength(value,"utf8")>2048) ||
        Buffer.byteLength(JSON.stringify(texts),"utf8")>65536)
      throw authorityError("Template snapshot exceeds publication limits",409);
    const version = await tx.routeTemplateConfigurationVersion.create({data:{
      tenantId:membership.tenantId!,companyId:membership.companyId,templateId,
      actorUserId:args.user.id,companyMembershipId:args.user.companyMembershipId!,tenantMembershipId:membership.tenantMembershipId!,
      operationId,intentSha256,expectedRevision:args.expectedRevision,revision:args.expectedRevision+1,
      name:template.name,code:template.code,isActive:template.isActive,priority:template.priority,
      serviceType:template.serviceType,transportMode:template.transportMode,originCountryCode:template.originCountryCode,destinationCountryCode:template.destinationCountryCode,
      legCount:template.legs.length,
    },select:{id:true,templateId:true,revision:true,operationId:true,acceptedAt:true}});
    if (template.legs.length) await tx.routeTemplateConfigurationLeg.createMany({data:template.legs.map(l=>({
      versionId:version.id,templateId,sourceLegId:l.id,sequence:l.sequence,legCode:l.legCode,label:l.label,mode:l.mode,
      originCountryCode:l.originCountryCode,destinationCountryCode:l.destinationCountryCode,
    }))});
    const changed = await tx.routeTemplate.updateMany({where:{...owner,id:templateId,configurationRevision:args.expectedRevision,currentConfigurationId:template.currentConfigurationId},
      data:{configurationRevision:version.revision,currentConfigurationId:version.id,updatedByUserId:args.user.id}});
    if (changed.count!==1) conflict();
    return result(version);
  },{maxWait:2000,timeout:5000});
}
function result(row:{id:string;templateId:string;revision:number;operationId:string;acceptedAt:Date}) {
  return {id:row.id,templateId:row.templateId,revision:row.revision,operationId:row.operationId,acceptedAt:row.acceptedAt.toISOString()};
}
