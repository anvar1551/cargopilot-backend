jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
jest.mock("../../src/modules/identity-access/access-control", () => ({ loadAccessSnapshot: jest.fn(), buildSupportScopeWhere: jest.fn(), buildOrderScopeWhere: jest.fn() }));
jest.mock("../../src/modules/analytics-core/infrastructure/analyticsOutbox", () => ({ enqueueCargoPilotDomainEventTx: jest.fn(async () => undefined) }));
import { database, expectNoSensitiveFields } from "./fixtures";
import { loadAccessSnapshot, buildSupportScopeWhere, buildOrderScopeWhere } from "../../src/modules/identity-access/access-control";
import { enqueueCargoPilotDomainEventTx } from "../../src/modules/analytics-core/infrastructure/analyticsOutbox";
import { createSupportTicket, getSupportTicketScoped, listSupportTickets, updateSupportTicketStatus, assignSupportTicket, addSupportTicketMessage, addSupportTicketNote, createSupportQueue, updateSupportQueue } from "../../src/modules/support-core/application/supportService";
import { createSystemSupportTicket } from "../../src/modules/support-core/application/autoTriage";
import { supportAssignee } from "../../src/modules/support-core/application/supportAccess";
const actor: any = { id: "user-a", companyId: "company-a", tenantId: "tenant-a", tenantMembershipId: "tm-a", companyMembershipId: "cm-a", membershipId: "cm-a", name: "Synthetic", customerEntityId: null, warehouseId: null,
  permissionCodes: ["support.view","support.createTicket","support.update","support.assign","support.resolve","support.configure","shipment.view"], scopes: [{ scopeType: "company", scopeRefId: "company-a" }] };
const snapshot: any = { ...actor, userId: actor.id };
const ticket: any = { id: "ticket-a", tenantId: actor.tenantId, ownerOrgId: actor.companyId, ticketNumber: "SYNTHETIC-TICKET", title: "Synthetic", status: "open", orderId: null, ownerId: null, ownerCompanyMembershipId: null, archivedAt: null,
 messages: [{ id: "message-a", body: "Synthetic", password: "SENSITIVE-CANARY" }], createdAt: new Date(), lastActivityAt: new Date() };
beforeEach(() => {
 jest.mocked(loadAccessSnapshot).mockReset().mockResolvedValue(snapshot);
 jest.mocked(buildSupportScopeWhere).mockReset().mockResolvedValue({ ownerOrgId: actor.companyId });
 jest.mocked(buildOrderScopeWhere).mockReset().mockResolvedValue({ customerEntityId: "scoped-customer" });
 jest.mocked(enqueueCargoPilotDomainEventTx).mockClear();
 for(const [model,methods] of Object.entries({ supportTicket:["findFirst","findMany","count","create","update"], supportTicketEvent:["create"], supportTicketMessage:["create"], supportTicketNote:["create"], supportQueue:["findFirst","create","update","updateMany"], supportAssignmentRule:["findMany"], supportSlaPolicy:["findMany"], companyMembership:["findUnique"], userNotification:["create"], counter:["upsert"], order:["findFirst"] })) for(const method of methods) database[model][method].mockReset();
 database.$queryRaw.mockReset().mockResolvedValue([]); database.$transaction.mockReset().mockImplementation(async (fn: any) => fn(database));
 database.supportTicket.findFirst.mockResolvedValue(ticket); database.supportTicket.findMany.mockResolvedValue([ticket]); database.supportTicket.count.mockResolvedValue(1);
 database.supportTicket.update.mockImplementation(async ({data}: any) => ({ ...ticket, ...data })); database.supportTicket.create.mockImplementation(async ({data}: any) => ({ ...ticket, ...data }));
 database.supportTicketEvent.create.mockResolvedValue({}); database.supportTicketMessage.create.mockResolvedValue({}); database.supportTicketNote.create.mockResolvedValue({});
 database.supportAssignmentRule.findMany.mockResolvedValue([]); database.supportQueue.findFirst.mockResolvedValue(null); database.supportSlaPolicy.findMany.mockResolvedValue([]); database.counter.upsert.mockResolvedValue({ value: 1 });
 database.companyMembership.findUnique.mockResolvedValue({ id: "cm-a", tenantMembershipId: "tm-a" }); database.userNotification.create.mockResolvedValue({});
});
function noEffects() { expect(database.supportTicket.create).not.toHaveBeenCalled(); expect(database.supportTicket.update).not.toHaveBeenCalled(); expect(database.supportTicketEvent.create).not.toHaveBeenCalled(); expect(database.supportTicketMessage.create).not.toHaveBeenCalled(); expect(database.userNotification.create).not.toHaveBeenCalled(); expect(enqueueCargoPilotDomainEventTx).not.toHaveBeenCalled(); }
test("authorized list and detail derive tenant/company/object/order filters, safe child projections", async () => {
 const result = await listSupportTickets({actor,scopeWhere:{}}); expect(result.payload.items).toHaveLength(1); expectNoSensitiveFields(result);
 const detail=await getSupportTicketScoped({actor,id:ticket.id,scopeWhere:{}}); expectNoSensitiveFields(detail);
 for(const model of [database.supportTicket.findMany,database.supportTicket.findFirst]) { const q=model.mock.calls[0][0]; expect(JSON.stringify(q.where)).toContain('"tenantId":"tenant-a"'); expect(JSON.stringify(q.where)).toContain('"ownerOrgId":"company-a"'); expect(JSON.stringify(q.where)).toContain("scoped-customer"); }
 expect(database.supportTicket.findFirst.mock.calls[0][0].select.messages.select).toEqual(expect.objectContaining({id:true,body:true}));
});
test.each([undefined,{...actor,tenantId:null},{...actor,membershipId:"wrong"}])("missing/partial/forged selection denies all effects",async context=>{
 await expect(createSupportTicket({title:"Synthetic"},context)).rejects.toMatchObject({statusCode:403}); noEffects(); expect(database.$transaction).not.toHaveBeenCalled();
});
test.each([null,{...snapshot,permissionCodes:[]},{...snapshot,companyId:"company-b"},{...snapshot,tenantId:"tenant-b"}])("revoked/foreign/mismatched context fails closed",async value=>{
 jest.mocked(loadAccessSnapshot).mockResolvedValue(value); await expect(getSupportTicketScoped({actor,id:ticket.id})).rejects.toMatchObject({statusCode:403}); noEffects(); expect(database.supportTicket.findFirst).not.toHaveBeenCalled();
});
test.each(["tenantId","ownerOrgId","companyId","ownerCompanyMembershipId","warehouseId","customerEntityId","driverId","queueId"])("rejects caller %s ownership before writes",async key=>{
 await expect(createSupportTicket({title:"Synthetic",[key]:"foreign"} as any,actor)).rejects.toMatchObject({statusCode:400}); noEffects();
});
test("owned creation writes authoritative identity, history and durable event together",async()=>{
 await expect(createSupportTicket({title:"Synthetic"},actor)).resolves.toMatchObject({id:ticket.id});
 expect(database.supportTicket.create.mock.calls[0][0].data).toMatchObject({tenantId:actor.tenantId,ownerOrgId:actor.companyId,status:"open"});
 expect(jest.mocked(enqueueCargoPilotDomainEventTx).mock.calls[0][0]).toBe(database);
 expect(jest.mocked(enqueueCargoPilotDomainEventTx).mock.calls[0][1]).toMatchObject({tenantScope:"tenant:tenant-a:company:company-a"});
});
test("unauthorized prospective creation scope causes no writes",async()=>{
 jest.mocked(loadAccessSnapshot).mockResolvedValue({...snapshot,scopes:[{scopeType:"warehouse",scopeRefId:"warehouse-a"}]});
 jest.mocked(buildSupportScopeWhere).mockResolvedValue({customerEntityId:"foreign-customer"});
 await expect(createSupportTicket({title:"Synthetic"},actor)).rejects.toMatchObject({statusCode:403}); noEffects();
});
test.each(["foreign-tenant","other-company","wrong-order-number"])("linked %s order rejected before mutations",async _kind=>{
 database.order.findFirst.mockResolvedValue(null); await expect(createSupportTicket({title:"Synthetic",orderId:"foreign",orderNumber:"conflicting"},actor)).rejects.toMatchObject({statusCode:404}); noEffects();
 const where=database.order.findFirst.mock.calls[0][0].where; expect(where.AND).toContainEqual({tenantId:actor.tenantId,ownerOrgId:actor.companyId}); expect(where.AND).toContainEqual({id:"foreign"}); expect(where.AND).toContainEqual({orderNumber:"conflicting"});
});
test.each(["foreign","same-tenant-other-company","legacy","wrong-parent"])("mutation denied against %s parent with zero child/outbox effects",async _kind=>{
 database.supportTicket.findFirst.mockResolvedValue(null);
 await expect(addSupportTicketMessage("foreign","Synthetic",actor)).rejects.toMatchObject({statusCode:404}); noEffects();
});
test("authorized message is parent-bound, locked and transactionally updates history/outbox",async()=>{
 await addSupportTicketMessage(ticket.id,"Synthetic reply",actor); expect(database.$queryRaw).toHaveBeenCalled();
 expect(database.supportTicketMessage.create.mock.calls[0][0].data).toMatchObject({ticketId:ticket.id,authorId:actor.id});
 const where=database.supportTicket.update.mock.calls[0][0].where; expect(where.id).toBe(ticket.id); expect(JSON.stringify(where.AND)).toContain('"tenantId":"tenant-a"'); expect(JSON.stringify(where.AND)).toContain('"ownerOrgId":"company-a"'); expect(enqueueCargoPilotDomainEventTx).toHaveBeenCalledTimes(1);
});
test("wrong assignee user/tenant/permission/scope rejected before update",async()=>{
 jest.mocked(loadAccessSnapshot).mockImplementation(async (args:any)=>args.userId===actor.id?snapshot:null);
 await expect(assignSupportTicket(ticket.id,"foreign-user",actor)).rejects.toMatchObject({statusCode:400}); noEffects();
});
test("removed transition permission cannot resolve, and internal notes require internal scope",async()=>{
 jest.mocked(loadAccessSnapshot).mockResolvedValue({...snapshot,permissionCodes:["support.view","support.update"]});
 await expect(updateSupportTicketStatus(ticket.id,"resolved",actor)).rejects.toMatchObject({statusCode:403});
 await expect(addSupportTicketNote(ticket.id,"Synthetic note",actor)).rejects.toMatchObject({statusCode:403}); noEffects(); expect(database.supportTicketNote.create).not.toHaveBeenCalled();
});
test("legacy generic service producer remains contained without DB or human impersonation",async()=>{
 expect(await createSystemSupportTicket({sourceKey:"untrusted",title:"Synthetic",companyId:"foreign"})).toBeNull(); noEffects(); expect(loadAccessSnapshot).not.toHaveBeenCalled();
});
test("foreign configuration company or default organization rejects before effects",async()=>{
 await expect(createSupportQueue({companyId:"foreign",name:"Synthetic"},actor)).rejects.toMatchObject({statusCode:403});
 await expect(updateSupportQueue("queue-a",{defaultOrgId:"foreign"},actor)).rejects.toMatchObject({statusCode:403}); noEffects(); expect(database.supportQueue.update).not.toHaveBeenCalled();
});


test("missing shipment scope uses an empty ID set rather than a global or invalid UUID fallback", async () => {
 jest.mocked(buildOrderScopeWhere).mockResolvedValue({id:"__no_access__"});
 await listSupportTickets({actor});
 const query=JSON.stringify(database.supportTicket.findMany.mock.calls[0][0].where);
 expect(query).toContain('"id":{"in":[]}'); expect(query).not.toContain("__no_access__");
});
test("unsupported maintenance capability rejects before durable reads or writes", async () => {
 const {maintainOwnedSupportTickets}=await import("../../src/modules/support-core/application/supportMaintenance");
 await expect(maintainOwnedSupportTickets("other" as any)).rejects.toThrow("Invalid support maintenance capability");
 noEffects(); expect(database.supportTicket.findMany).not.toHaveBeenCalled();
});

test("nested order denial and empty support scope cannot become unrestricted queries",async()=>{
 jest.mocked(buildOrderScopeWhere).mockResolvedValue({AND:[{tenantId:actor.tenantId},{id:"__no_access__"}]});
 await listSupportTickets({actor});expect(JSON.stringify(database.supportTicket.findMany.mock.calls[0][0].where)).not.toContain("__no_access__");
 expect(JSON.stringify(database.supportTicket.findMany.mock.calls[0][0].where)).toContain('"id":{"in":[]}');
 jest.mocked(buildSupportScopeWhere).mockResolvedValue({});await expect(createSupportTicket({title:"Denied"},actor)).rejects.toMatchObject({statusCode:403});noEffects();
});

test("authorized assignment, resolution and internal note retain transactional parent scope",async()=>{
 await assignSupportTicket(ticket.id,actor.id,actor);
 expect(database.supportTicket.update.mock.calls[0][0].data).toMatchObject({ownerId:actor.id,ownerCompanyMembershipId:actor.membershipId});
 await updateSupportTicketStatus(ticket.id,"resolved",actor);
 expect(database.supportTicket.update.mock.calls[1][0].data).toMatchObject({status:"resolved"});
 await addSupportTicketNote(ticket.id,"Synthetic internal note",actor);
 expect(database.supportTicketNote.create.mock.calls[0][0].data).toMatchObject({ticketId:ticket.id,actorId:actor.id});expect(enqueueCargoPilotDomainEventTx).toHaveBeenCalledTimes(3);
});
test("authorized queue creation derives selected company and uses a durable transaction",async()=>{
 database.supportQueue.create.mockImplementation(async({data}:any)=>({id:"queue-a",...data}));
 await expect(createSupportQueue({name:"Synthetic queue"},actor)).resolves.toMatchObject({id:"queue-a",companyId:actor.companyId});
 expect(database.supportQueue.create.mock.calls[0][0].data).toMatchObject({companyId:actor.companyId,name:"Synthetic queue"});expect(enqueueCargoPilotDomainEventTx).toHaveBeenCalledTimes(1);
});
test("alternate configuration caller cannot inject nested ownership relations",async()=>{
 await expect(createSupportQueue({name:"Synthetic queue",company:{connect:{id:"foreign"}}},actor)).rejects.toMatchObject({statusCode:400});expect(database.supportQueue.create).not.toHaveBeenCalled();noEffects();
});
