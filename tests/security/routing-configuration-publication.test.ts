jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:require("./fixtures").database}));
jest.mock("../../src/modules/orders-core/domain/company-authority",()=>({requireTenantBoundOrderCompanyAuthority:jest.fn(),hasCompanyScope:jest.fn(()=>true)}));
import {Prisma} from "@prisma/client";
import {database as db} from "./fixtures";
import {requireTenantBoundOrderCompanyAuthority,hasCompanyScope} from "../../src/modules/orders-core/domain/company-authority";
import {publishCarrierRoutingConfigurationForActor as publish} from "../../src/modules/integrations-core/application/routing-configuration-publication";
const ruleId="019b3000-0000-7000-8b00-000000000021",operationId="019b3000-0000-7000-8b00-000000000022";
const user:any={id:"user",tenantId:"tenant",companyId:"company",membershipId:"cm",companyMembershipId:"cm",tenantMembershipId:"tm"};
let rule:any,provider:any;
beforeEach(()=>{
 jest.clearAllMocks();jest.mocked(requireTenantBoundOrderCompanyAuthority).mockResolvedValue({companyId:"company",tenantId:"tenant",tenantMembershipId:"tm"} as any);jest.mocked(hasCompanyScope).mockReturnValue(true);
 rule={id:ruleId,companyId:"company",configurationRevision:0,currentConfigurationId:null,providerId:"provider",fallbackProviderId:null,routeTemplateId:null,routeTemplateLegId:null,name:"Synthetic",code:null,isActive:true,priority:0,autoBook:true,serviceType:null,transportMode:null,originCountryCode:null,destinationCountryCode:null,minWeightKg:new Prisma.Decimal("1.23"),maxWeightKg:new Prisma.Decimal("2.34"),legSequence:null,conditionsJson:null};
 provider={id:"provider",companyId:"company",configurationRevision:1,currentConfigurationId:"version",currentConfiguration:{id:"version",providerId:"provider",companyId:"company",revision:1,domain:"carrier",status:"active"}};
 db.$transaction.mockImplementation(async(work:any)=>work(db));db.$executeRaw.mockResolvedValue(0);db.$queryRaw.mockResolvedValue([{locked:1}]);
 db.carrierRoutingRule.findFirst.mockReset().mockImplementation(async()=>rule);db.carrierRoutingConfigurationVersion.findUnique.mockReset().mockResolvedValue(null);
 db.integrationProvider.findFirst.mockReset().mockImplementation(async()=>provider);
 db.carrierRoutingConfigurationVersion.create.mockReset().mockImplementation(async({data}:any)=>({...data,id:"receipt",acceptedAt:new Date()}));
 db.carrierRoutingRule.updateMany.mockReset().mockResolvedValue({count:1});
 db.routeTemplate.findFirst.mockReset().mockResolvedValue({id:"template",configurationRevision:1,currentConfigurationId:"tv"});
 db.routeTemplateConfigurationLeg.findFirst.mockReset().mockResolvedValue({sourceLegId:"leg"});
});
function noWrites(){expect(db.carrierRoutingConfigurationVersion.create).not.toHaveBeenCalled();expect(db.carrierRoutingRule.updateMany).not.toHaveBeenCalled();expect(db.integrationOutbox.create).not.toHaveBeenCalled();}
const intent=()=>({user,ruleId,operationId,expectedRevision:0});
it("derives immutable owned provider references and preserves exact decimals without projecting secrets",async()=>{
 expect(Object.keys(await publish(intent())).sort()).toEqual(["acceptedAt","id","operationId","revision","ruleId"]);
 const data=db.carrierRoutingConfigurationVersion.create.mock.calls[0][0].data;
 expect(data.providerVersionId).toBe("version");expect(data.minWeightKg.toFixed(2)).toBe("1.23");
 expect(data).toMatchObject({companyId:"company",tenantId:"tenant",companyMembershipId:"cm",tenantMembershipId:"tm",actorUserId:"user"});
 const locks=db.$queryRaw.mock.calls.filter((c:any[])=>c[0].join("").includes('FROM "'));
 expect(locks.length).toBeGreaterThan(0);expect(locks.every((c:any[])=>c[0].join("").includes('AND "companyId"=') && c.slice(1).includes("company"))).toBe(true);
});
it.each(["permission","scope","foreign","unaccepted","wrong-provider","conditions","weight","stale","unaccepted-template","wrong-child"])("rejects %s without business effects",async kind=>{
 if(kind==="permission")jest.mocked(requireTenantBoundOrderCompanyAuthority).mockRejectedValue(Error("denied"));
 if(kind==="scope")jest.mocked(hasCompanyScope).mockReturnValue(false);
 if(kind==="foreign")db.carrierRoutingRule.findFirst.mockResolvedValue(null);
 if(kind==="unaccepted")provider.currentConfigurationId=null;
 if(kind==="wrong-provider")provider.currentConfiguration.providerId="foreign";
 if(kind==="conditions")rule.conditionsJson={unsupported:true};
 if(kind==="weight")rule.minWeightKg=new Prisma.Decimal("9");
 if(kind==="stale")rule.configurationRevision=1;
 if(kind==="unaccepted-template"){rule.routeTemplateId="template";db.routeTemplate.findFirst.mockResolvedValue(null);}
 if(kind==="wrong-child"){rule.routeTemplateId="template";rule.routeTemplateLegId="leg";db.routeTemplateConfigurationLeg.findFirst.mockResolvedValue(null);}
 await expect(publish(intent())).rejects.toThrow();noWrites();
});
it("caller ownership is rejected before transaction admission",async()=>{await expect(publish({...intent(),tenantId:"foreign"} as any)).rejects.toMatchObject({statusCode:400});expect(db.$transaction).not.toHaveBeenCalled();noWrites();});
it("an authorized identical retry returns the original receipt without reselecting provider versions",async()=>{
 const result=await publish(intent()),data=db.carrierRoutingConfigurationVersion.create.mock.calls[0][0].data;
 rule.configurationRevision=1;rule.currentConfigurationId=result.id;db.carrierRoutingConfigurationVersion.findUnique.mockResolvedValue({...data,...result,acceptedAt:new Date(result.acceptedAt)});
 jest.clearAllMocks();expect(await publish(intent())).toEqual(result);noWrites();expect(db.integrationProvider.findFirst).not.toHaveBeenCalled();
});
