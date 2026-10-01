jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:require("./fixtures").database}));
jest.mock("../../src/config/redis",()=>({getRedisClient:jest.fn(async()=>null),getRedisPrefix:()=>"test",withRedisTimeout:async(_name:string,work:()=>Promise<unknown>)=>work()}));
jest.mock("../../src/modules/identity-access/access-control",()=>({loadAccessSnapshot:jest.fn(),hasAnyPermissionSync:jest.fn()}));
jest.mock("../../src/modules/identity-access/transport/fastify-auth",()=>({fastifyAuth:()=>async(request:any)=>{request.user=mockActor;}}));
import Fastify from "fastify";
import { database } from "./fixtures";
import { loadAccessSnapshot } from "../../src/modules/identity-access/access-control";
import { prismaFinanceRepository as repo } from "../../src/modules/finance-core/infrastructure/prisma-finance.repository";
import { FinanceService } from "../../src/modules/finance-core/application/finance.service";
import routes from "../../src/modules/finance-core/transport/fastify-routes";
const mockActor:any={id:"u",tenantId:"t",tenantMembershipId:"tm",companyId:"c",companyMembershipId:"cm",membershipId:"cm"};
const snapshot:any={...mockActor,userId:"u",permissionCodes:["finance.journals.read"],scopes:[{scopeType:"company",scopeRefId:"c"}]};
const service=new FinanceService(repo);


const id="11111111-1111-4111-8111-111111111111";
const command:any={companyId:"c",actorUserId:"u",journalId:id,postingDate:new Date("2026-01-01"),reason:"Synthetic reversal",idempotencyKey:"synthetic-retry",approved:true,checkerUserId:"other"};
beforeEach(()=>{jest.clearAllMocks();jest.mocked(loadAccessSnapshot).mockResolvedValue({...snapshot,permissionCodes:["finance.journals.post","finance.journals.reverse"]});database.membershipScope.findFirst.mockReset().mockResolvedValue({id:"scope"});});
afterEach(()=>{expect(database.$transaction).not.toHaveBeenCalled();for(const model of ["financeJournalEntry","financeJournalLine","financeDocument","financeAuditEvent","financeDomainEventOutbox"])for(const op of ["create","update","updateMany","upsert","delete"])expect(database[model][op]).not.toHaveBeenCalled();});
test("permission-bearing maker/checker flags do not constitute durable approval",async()=>{for(const call of [()=>service.postJournal(mockActor,id),()=>repo.postJournal(mockActor,id),()=>service.reverseJournal(command,mockActor),()=>repo.reverseJournal(command,mockActor)])await expect(call()).rejects.toMatchObject({statusCode:409,code:"FINANCE_MANUAL_APPROVAL_REQUIRED"});});
test.each([null,{...mockActor,tenantId:null},{...mockActor,membershipId:"foreign"}])("missing/conflicting context remains denied before approval handling",async actor=>{await expect(repo.postJournal(actor,id)).rejects.toMatchObject({statusCode:403});await expect(repo.reverseJournal(command,actor)).rejects.toMatchObject({statusCode:403});});
test.each([null,{...snapshot,permissionCodes:[]},{...snapshot,companyId:"foreign"},{...snapshot,tenantId:"foreign"},{...snapshot,scopes:[]}])("fresh revoked or insufficient context fails closed",async value=>{jest.mocked(loadAccessSnapshot).mockResolvedValue(value);await expect(service.postJournal(mockActor,id)).rejects.toMatchObject({statusCode:403});await expect(service.reverseJournal(command,mockActor)).rejects.toMatchObject({statusCode:403});});
test("HTTP reports policy containment without protected reads or financial effects",async()=>{const app=Fastify();await app.register(routes);try{for(const request of [{method:"POST" as const,url:"/journals/"+id+"/post"},{method:"POST" as const,url:"/journals/"+id+"/reverse",payload:{postingDate:"2026-01-01",reason:"Synthetic reversal",idempotencyKey:"synthetic-retry"}}]){const response=await app.inject(request);expect(response.statusCode).toBe(409);expect(response.json().code).toBe("FINANCE_MANUAL_APPROVAL_REQUIRED");}expect(database.financeJournalEntry.findFirst).not.toHaveBeenCalled();}finally{await app.close();}});
