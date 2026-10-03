import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import { buildCargoPilotDomainEvent, type CargoPilotDomainEvent } from "../realtime/analyticsEvents";
export type DomainEventInput = Omit<CargoPilotDomainEvent,"id"|"occurredAt"|"schemaVersion"> & {
  id?:string; occurredAt?:string; companySubjectId?:string;
};
export function analyticsAcceptanceHash(row:any):string {
  function stable(value:any):any { if(Array.isArray(value))return value.map(stable); if(value&&typeof value==="object")return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));return value; }
  return createHash("sha256").update(JSON.stringify(stable({eventId:row.eventId,type:row.type,tenantScope:row.tenantScope,entityId:row.entityId,
    occurredAt:new Date(row.occurredAt).toISOString(),schemaVersion:row.schemaVersion,payload:row.payload,tenantId:row.tenantId,companyId:row.companyId,
    orderId:row.orderId,ticketId:row.ticketId,capability:row.capability,acceptedAt:new Date(row.acceptedAt).toISOString()}))).digest("hex");
}
function deny():never { throw Object.assign(new Error("Authoritative analytics source required"),{statusCode:409}); }
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Trusted source transactions retain their own action/object/workflow checks. Strings are not authority. */
export async function resolveAnalyticsSource(tx:Prisma.TransactionClient,input:DomainEventInput) {
  let tenantId:string|null=null,companyId:string|null=null,assignedCompany:string|null=null,orderId:string|null=null,ticketId:string|null=null,capability:string;
  if(input.companySubjectId) {
    if(input.type!=="support_ticket_changed"||input.entityId!==null||input.payload?.reason!=="configuration_changed"||!uuid.test(input.companySubjectId))return deny();
    const company=await tx.organization.findUnique({where:{id:input.companySubjectId},select:{id:true,tenantId:true}});
    if(!company)return deny();tenantId=company.tenantId;companyId=company.id;capability="support_configuration";
  } else if(input.type==="support_ticket_changed") {
    if(!input.entityId||!uuid.test(input.entityId))return deny();
    await tx.$queryRaw`SELECT id FROM "SupportTicket" WHERE id=${input.entityId}::uuid FOR SHARE`;
    const ticket=await tx.supportTicket.findUnique({where:{id:input.entityId},select:{tenantId:true,ownerOrgId:true,assignedOrgId:true}});
    if(!ticket)return deny();tenantId=ticket.tenantId;companyId=ticket.ownerOrgId;assignedCompany=ticket.assignedOrgId;ticketId=input.entityId.toLowerCase();capability="support_event";
  } else {
    if(!["order_created","order_status_changed","manual_refresh","cash_handoff","cash_settled","finance_source_event"].includes(input.type)||!input.entityId||!uuid.test(input.entityId))return deny();
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${input.entityId}::uuid FOR SHARE`;
    const order=await tx.order.findUnique({where:{id:input.entityId},select:{tenantId:true,ownerOrgId:true,assignedOrgId:true}});
    if(!order)return deny();tenantId=order.tenantId;companyId=order.ownerOrgId;assignedCompany=order.assignedOrgId;orderId=input.entityId.toLowerCase();
    capability=input.type==="finance_source_event"?"cash_finance_source":["cash_handoff","cash_settled"].includes(input.type)?"cash_event":"order_event";
    if(capability.startsWith("cash")) {
      const eventId=capability==="cash_event"?input.payload.cashOperationEventId:String(input.payload.sourceEventId??"").replace(/^cash:/,"");
      if(typeof eventId!=="string"||!uuid.test(eventId))return deny();
      const operation=await tx.cashCustodyOperation.findUnique({where:{eventId},select:{tenantId:true,companyId:true,orderId:true,action:true}});
      if(!operation||operation.tenantId!==tenantId||operation.companyId!==companyId||operation.orderId!==orderId)return deny();
      if(capability==="cash_finance_source"&&(input.payload.sourceType!=="cash_custody"||input.id!==`finance:cash:${eventId}`))return deny();
      if(capability==="cash_event"&&(input.id!==`cash-operation:${eventId}`||(input.type==="cash_settled")!==(operation.action==="settle")))return deny();
    }
  }
  if(!tenantId||!companyId)return deny();
  await tx.$queryRaw`SELECT c.id FROM "Organization" c JOIN "Tenant" t ON t.id=c."tenantId"
    WHERE c.id=${companyId}::uuid AND t.id=${tenantId}::uuid FOR SHARE OF c,t`;
  const company=await tx.organization.findFirst({where:{id:companyId,tenantId,isActive:true,tenant:{status:"active"}},select:{id:true}});
  if(!company)return deny();
  const scopes=[`company:${companyId}`,`tenant:${tenantId}:company:${companyId}`];
  if(assignedCompany)scopes.push(`company:${assignedCompany}`,`tenant:${tenantId}:company:${assignedCompany}`);
  if(!scopes.includes(input.tenantScope))return deny();
  return {tenantId,companyId,orderId,ticketId,capability};
}
export function buildOutboxDomainEvent(input:DomainEventInput){return buildCargoPilotDomainEvent(input);}
export async function enqueueCargoPilotDomainEventsTx(tx:Prisma.TransactionClient,inputs:DomainEventInput[]) {
  const records=[];const events=[];
  for(const input of inputs) {
    const owner=await resolveAnalyticsSource(tx,input);
    const payload=JSON.parse(JSON.stringify(input.payload));if(Buffer.byteLength(JSON.stringify(payload))>65536)return deny();
    const event=buildOutboxDomainEvent({...input,entityId:owner.orderId??owner.ticketId??null}),occurredAt=new Date(event.occurredAt);if(!Number.isFinite(occurredAt.getTime())||event.id.length>200)return deny();
    const row={eventId:event.id,type:event.type,tenantScope:event.tenantScope,entityId:event.entityId,schemaVersion:1,occurredAt,payload,...owner,acceptedAt:new Date(),publicationState:"ready"};
    records.push({...row,contentHash:analyticsAcceptanceHash(row)});events.push(event);
  }
  if(records.length)await tx.analyticsDomainEventOutbox.createMany({data:records});return events;
}
export async function enqueueCargoPilotDomainEventTx(tx:Prisma.TransactionClient,input:DomainEventInput){return (await enqueueCargoPilotDomainEventsTx(tx,[input]))[0];}
