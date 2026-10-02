jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:require("./fixtures").database}));
jest.mock("../../src/modules/orders-core/domain/company-authority",()=>({requireTenantBoundOrderCompanyAuthority:jest.fn(),hasCompanyScope:jest.fn(()=>true)}));
import {database as db} from "./fixtures";
import {requireTenantBoundOrderCompanyAuthority,hasCompanyScope} from "../../src/modules/orders-core/domain/company-authority";
import {publishRouteTemplateConfigurationForActor as publish} from "../../src/modules/integrations-core/application/template-configuration-publication";
const templateId="019b3000-0000-7000-8b00-000000000011",operationId="019b3000-0000-7000-8b00-000000000012";
const user:any={id:"user",tenantId:"tenant",companyId:"company",membershipId:"cm",companyMembershipId:"cm",tenantMembershipId:"tm"};
let template:any;
beforeEach(()=>{
 jest.clearAllMocks();jest.mocked(requireTenantBoundOrderCompanyAuthority).mockResolvedValue({companyId:"company",tenantId:"tenant",tenantMembershipId:"tm"} as any);
 jest.mocked(hasCompanyScope).mockReturnValue(true);
 template={id:templateId,companyId:"company",configurationRevision:0,currentConfigurationId:null,name:"Synthetic",code:null,isActive:true,priority:0,
 serviceType:null,transportMode:null,originCountryCode:null,destinationCountryCode:null,metadata:"DO-NOT-COPY",legs:[{id:"leg",routeTemplateId:templateId,sequence:1,legCode:"road",label:null,mode:"road",originCountryCode:null,destinationCountryCode:null,metadata:"DO-NOT-COPY"}]};
 db.$transaction.mockImplementation(async(work:any)=>work(db));db.$executeRaw.mockResolvedValue(0);db.$queryRaw.mockResolvedValue([{locked:1}]);
 db.routeTemplate.findFirst.mockReset().mockImplementation(async()=>template);db.routeTemplateConfigurationVersion.findUnique.mockReset().mockResolvedValue(null);
 db.routeTemplateConfigurationVersion.create.mockReset().mockImplementation(async({data}:any)=>({...data,id:"receipt",acceptedAt:new Date()}));
 db.routeTemplateConfigurationLeg.createMany.mockReset().mockResolvedValue({count:1});db.routeTemplate.updateMany.mockReset().mockResolvedValue({count:1});
});
const intent=()=>({user,templateId,operationId,expectedRevision:0});
function noWrites(){expect(db.routeTemplateConfigurationVersion.create).not.toHaveBeenCalled();expect(db.routeTemplateConfigurationLeg.createMany).not.toHaveBeenCalled();expect(db.routeTemplate.updateMany).not.toHaveBeenCalled();expect(db.integrationOutbox.create).not.toHaveBeenCalled();}
it("publishes bounded typed server snapshots and minimal receipt through selected authority",async()=>{
 const result=await publish(intent());expect(Object.keys(result).sort()).toEqual(["acceptedAt","id","operationId","revision","templateId"]);
 expect(jest.mocked(requireTenantBoundOrderCompanyAuthority).mock.calls[0][2]).toBe("integration.routing.manage");
 expect(db.routeTemplate.updateMany.mock.calls[0][0]).toMatchObject({where:{id:templateId,companyId:"company",configurationRevision:0,currentConfigurationId:null},data:{currentConfigurationId:"receipt",configurationRevision:1}});
 const data=db.routeTemplateConfigurationVersion.create.mock.calls[0][0].data;
 expect(data).toMatchObject({tenantId:"tenant",companyId:"company",actorUserId:"user",companyMembershipId:"cm",tenantMembershipId:"tm",legCount:1});
 const lock=db.$queryRaw.mock.calls.find((c:any[])=>c[0].join("").includes('FROM "RouteTemplate"'))!;
 expect(lock[0].join("")).toContain('AND "companyId"=');expect(lock.slice(1)).toContain("company");
 expect(JSON.stringify([data,db.routeTemplateConfigurationLeg.createMany.mock.calls[0][0]])).not.toContain("DO-NOT-COPY");
});
it.each(["permission","scope","foreign","stale","capacity","bytes","wrong-child"])("rejects %s without business effects",async kind=>{
 if(kind==="permission")jest.mocked(requireTenantBoundOrderCompanyAuthority).mockRejectedValue(Error("denied"));
 if(kind==="scope")jest.mocked(hasCompanyScope).mockReturnValue(false);
 if(kind==="foreign")db.routeTemplate.findFirst.mockResolvedValue(null);
 if(kind==="stale")template.configurationRevision=1;
 if(kind==="capacity")template.legs=Array.from({length:101},()=>template.legs[0]);
 if(kind==="bytes")template.name="x".repeat(2049);
 if(kind==="wrong-child")template.legs[0].routeTemplateId="foreign";
 await expect(publish(intent())).rejects.toThrow();noWrites();
});
it("rejects caller ownership or scalar authoring before admission",async()=>{await expect(publish({...intent(),tenantId:"foreign"} as any)).rejects.toMatchObject({statusCode:400});expect(db.$transaction).not.toHaveBeenCalled();noWrites();});
it("matching authorized retry returns existing receipt without writes",async()=>{
 const accepted=await publish(intent());const data=db.routeTemplateConfigurationVersion.create.mock.calls[0][0].data;
 db.routeTemplateConfigurationVersion.findUnique.mockResolvedValue({...data,...accepted,acceptedAt:new Date(accepted.acceptedAt)});template.configurationRevision=1;template.currentConfigurationId=accepted.id;
 jest.clearAllMocks();expect(await publish(intent())).toEqual(accepted);noWrites();
});
it("conflicting receipt context cannot authorize an operation",async()=>{db.routeTemplateConfigurationVersion.findUnique.mockResolvedValue({intentSha256:"wrong"});await expect(publish(intent())).rejects.toMatchObject({statusCode:409});noWrites();});
it("lost publication CAS never acknowledges success",async()=>{db.routeTemplate.updateMany.mockResolvedValue({count:0});await expect(publish(intent())).rejects.toMatchObject({statusCode:409});});
