jest.mock("../../src/modules/identity-access/access-control",()=>({authorize:jest.fn(),loadAccessSnapshot:jest.fn()}));
jest.mock("../../src/modules/identity-access/application/access-session",()=>({
 ...jest.requireActual("../../src/modules/identity-access/application/access-session"),hasLiveAccessSession:jest.fn(),
}));
jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:require("./fixtures").database}));
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import {fastifyAuth} from "../../src/modules/identity-access/transport/fastify-auth";
import {authorize,loadAccessSnapshot} from "../../src/modules/identity-access/access-control";
import {hasLiveAccessSession} from "../../src/modules/identity-access/application/access-session";
import {database} from "./fixtures";
import * as diagnostics from "../../src/modules/identity-access/transport/auth-rejection-diagnostics";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const secret="synthetic-protected-auth-only-32-characters";
const claims={id:id(1),sid:id(2),tenantId:id(3),tenantMembershipId:id(4),companyId:id(5),companyMembershipId:id(6),membershipId:id(6),tokenType:"access"};
const snapshot:any={userId:claims.id,tenantId:claims.tenantId,tenantMembershipId:claims.tenantMembershipId,companyId:claims.companyId,companyMembershipId:claims.companyMembershipId,membershipId:claims.membershipId,permissionCodes:["allowed"],roleCodes:[],scopes:[],name:"SYNTHETIC",email:"synthetic@example.test"};
const token=(patch={})=>jwt.sign({...claims,...patch},secret,{expiresIn:3600});
const privateDetail="synthetic-private-token-email-password-db-detail";
const oldSecret=process.env.JWT_SECRET;
beforeEach(()=>{
 jest.clearAllMocks();jest.mocked(authorize).mockReset();jest.mocked(loadAccessSnapshot).mockReset();jest.mocked(hasLiveAccessSession).mockReset();process.env.JWT_SECRET=secret;jest.mocked(hasLiveAccessSession).mockResolvedValue(true);jest.mocked(loadAccessSnapshot).mockResolvedValue(snapshot);jest.mocked(authorize).mockResolvedValue(undefined);
 jest.spyOn(console,"warn").mockImplementation(()=>undefined);jest.spyOn(diagnostics,"recordAuthRejection").mockImplementation(diagnostics.createAuthRejectionReporter(()=>0));
});
afterEach(()=>{jest.restoreAllMocks();if(oldSecret===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=oldSecret;});
async function exercise(options:Parameters<typeof fastifyAuth>[0]={},header:string|undefined=`Bearer ${token()}`){
 const app=Fastify(),business=jest.fn(async()=>({ok:true}));app.get("/protected",{preHandler:fastifyAuth(options)},business);
 try {const response=await app.inject({url:"/protected",headers:header?{authorization:header,cookie:privateDetail}:{cookie:privateDetail}});return{response,business};}finally{await app.close();}
}
function denied(result:Awaited<ReturnType<typeof exercise>>,status:number,error:string,code:string){
 expect(result.response.statusCode).toBe(status);expect(result.response.json()).toEqual({error});expect(result.business).not.toHaveBeenCalled();expect(database.userRefreshSession.create).not.toHaveBeenCalled();
 expect(console.warn).toHaveBeenCalledWith(JSON.stringify({event:"authentication_rejected",code,suppressed:0}));expect(JSON.stringify(jest.mocked(console.warn).mock.calls)+result.response.body).not.toContain(privateDetail);
}
it.each(["missing","malformed","legacy"])("%s token fails before protected work",async kind=>{
 const result=await exercise({},kind==="missing"?"":kind==="malformed"?`Bearer ${privateDetail}`:`Bearer ${token({sid:undefined})}`);denied(result,401,"Unauthorized","ACCESS_SESSION_REJECTED");expect(loadAccessSnapshot).not.toHaveBeenCalled();
});
it("revoked exact session fails before membership or protected work",async()=>{jest.mocked(hasLiveAccessSession).mockResolvedValue(false);denied(await exercise(),401,"Unauthorized","ACCESS_SESSION_REJECTED");expect(loadAccessSnapshot).not.toHaveBeenCalled();});
it("missing/foreign fresh selected context denies and passes all verified claims to membership resolver",async()=>{
 jest.mocked(loadAccessSnapshot).mockResolvedValue(null);denied(await exercise(),401,"Unauthorized","ACCESS_SESSION_REJECTED");expect(loadAccessSnapshot).toHaveBeenCalledWith({userId:claims.id,membershipId:claims.membershipId,companyMembershipId:claims.companyMembershipId,companyId:claims.companyId,tenantId:claims.tenantId,tenantMembershipId:claims.tenantMembershipId,requireFresh:true});
});
it.each(["configuration","membership","permission"])("%s internal failure is static and fail-closed",async kind=>{
 if(kind==="configuration")delete process.env.JWT_SECRET;else if(kind==="membership")jest.mocked(loadAccessSnapshot).mockRejectedValue(Error(privateDetail));else jest.mocked(authorize).mockRejectedValue(Error(privateDetail));
 denied(await exercise({permission:"allowed"}),500,"Authentication unavailable","ACCESS_AUTHORITY_UNAVAILABLE");
});
it("expected permission denial cannot expose its message",async()=>{jest.mocked(authorize).mockRejectedValue(Object.assign(Error(privateDetail),{statusCode:403}));denied(await exercise({permission:"denied"}),403,"Forbidden","ACCESS_PERMISSION_REJECTED");});
it("anyPermission denial remains403 without exposing any exception",async()=>{jest.mocked(authorize).mockRejectedValue(Object.assign(Error(privateDetail),{statusCode:403}));denied(await exercise({anyPermission:["one","two"]}),403,"Forbidden","ACCESS_PERMISSION_REJECTED");expect(authorize).toHaveBeenCalledTimes(2);});
it("anyPermission dependency failure cannot fall through to a later successful grant",async()=>{jest.mocked(authorize).mockRejectedValueOnce(Error(privateDetail)).mockResolvedValueOnce(undefined);denied(await exercise({anyPermission:["one","two"]}),500,"Authentication unavailable","ACCESS_AUTHORITY_UNAVAILABLE");expect(authorize).toHaveBeenCalledTimes(1);});
it("authorized selected context and successful alternate permission keep the contract",async()=>{
 jest.mocked(authorize).mockRejectedValueOnce(Object.assign(Error("Forbidden"),{statusCode:403})).mockResolvedValueOnce(undefined);
 const {response,business}=await exercise({anyPermission:["one","two"]});expect(response.statusCode).toBe(200);expect(response.json()).toEqual({ok:true});expect(business).toHaveBeenCalledTimes(1);expect(authorize).toHaveBeenLastCalledWith(expect.objectContaining({id:claims.id,tenantId:claims.tenantId,companyId:claims.companyId,companyMembershipId:claims.companyMembershipId}),"two");expect(console.warn).not.toHaveBeenCalled();
});
