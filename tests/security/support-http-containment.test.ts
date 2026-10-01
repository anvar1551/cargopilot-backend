jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
jest.mock("../../src/modules/identity-access/transport/fastify-auth", () => ({ fastifyAuth: () => async (request: any) => { request.user = mockActor; } }));
jest.mock("../../src/modules/identity-access/access-control", () => ({ loadAccessSnapshot: jest.fn(), buildSupportScopeWhere: jest.fn(), buildOrderScopeWhere: jest.fn() }));
jest.mock("../../src/modules/analytics-core/infrastructure/analyticsOutbox", () => ({ enqueueCargoPilotDomainEventTx: jest.fn() }));
import Fastify from "fastify";
import routes from "../../src/modules/support-core/transport/fastify-routes";
import { database } from "./fixtures";
import { loadAccessSnapshot, buildSupportScopeWhere, buildOrderScopeWhere } from "../../src/modules/identity-access/access-control";
const mockActor: any = { id:"user-a",tenantId:"tenant-a",tenantMembershipId:"tm-a",companyId:"company-a",membershipId:"cm-a",companyMembershipId:"cm-a",permissionCodes:["support.view","support.update","support.createTicket"] };
let app: ReturnType<typeof Fastify>;
beforeEach(async () => {
 app=Fastify(); app.setValidatorCompiler(({schema}:any)=>(value:any)=>{const result=schema.safeParse(value);return result.success?{value:result.data}:{error:result.error};});
 await app.register(routes); await app.ready();
 jest.mocked(loadAccessSnapshot).mockResolvedValue({...mockActor,userId:mockActor.id});
 jest.mocked(buildSupportScopeWhere).mockResolvedValue({ownerOrgId:mockActor.companyId});jest.mocked(buildOrderScopeWhere).mockResolvedValue({id:{in:[]}});
 database.supportTicket.findMany.mockReset().mockResolvedValue([]);database.supportTicket.count.mockReset().mockResolvedValue(0);
 for(const [model,method] of [["supportTicket","update"],["supportTicket","create"],["supportTicketMessage","create"],["supportTicketNote","create"],["userNotification","create"]]) database[model][method].mockReset();
});
afterEach(async()=>{await app.close();});
test.each([
 {method:"POST",url:"/tickets",payload:{title:"Synthetic",tenantId:"foreign"}},
 {method:"POST",url:"/tickets",payload:{title:"Synthetic",priority:"not-a-priority"}},
 {method:"PATCH",url:"/tickets/ticket-a/status",payload:{status:"not-a-status"}},
 {method:"POST",url:"/tickets/ticket-a/messages",payload:{body:"Synthetic",ticketId:"other-parent"}},
 {method:"POST",url:"/queues",payload:{name:"Synthetic",companyId:"foreign"}},
])("HTTP rejects manipulated fields without business effects: $url",async(input:any)=>{
 const response=await app.inject(input);expect(response.statusCode).toBe(400);
 for(const [model,method] of [["supportTicket","update"],["supportTicket","create"],["supportTicketMessage","create"],["supportTicketNote","create"],["userNotification","create"]]) expect(database[model][method]).not.toHaveBeenCalled();
});
test("HTTP list keeps its existing response envelope with fresh server context",async()=>{
 const response=await app.inject({method:"GET",url:"/tickets"});expect(response.statusCode).toBe(200);expect(response.json().items).toEqual([]);
 expect(loadAccessSnapshot).toHaveBeenCalledWith(expect.objectContaining({requireFresh:true,tenantId:"tenant-a",companyId:"company-a"}));
});
test("unscoped SSE stays contained instead of subscribing to a global stream",async()=>{
 const response=await app.inject({method:"GET",url:"/stream"});expect(response.statusCode).toBe(503);
});
