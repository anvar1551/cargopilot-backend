jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:require("./fixtures").database}));
jest.mock("../../src/config/redis",()=>({getRedisClient:jest.fn(async()=>null),getRedisPrefix:()=>"test",withRedisTimeout:async(_name:string,work:()=>Promise<unknown>)=>work()}));
jest.mock("../../src/modules/identity-access/transport/fastify-auth",()=>({fastifyAuth:()=>async(request:any)=>{request.user={id:"synthetic-verified-user"};}}));
jest.mock("../../src/modules/identity-access/application/auth.service",()=>({changeUserPassword:jest.fn(),revokeRefreshSession:jest.fn(),loginUser:jest.fn(),refreshUserSession:jest.fn(),listUsersForCompany:jest.fn(),InvalidMembershipSelectionError:class extends Error{},MembershipSelectionRequiredError:class extends Error{}}));
import Fastify from "fastify";
import routes from "../../src/modules/identity-access/transport/fastify-routes";
import {changeUserPassword,revokeRefreshSession} from "../../src/modules/identity-access/application/auth.service";
import * as diagnostics from "../../src/modules/identity-access/transport/auth-rejection-diagnostics";
const privateValue="synthetic-password-token-cookie-detail";
beforeEach(()=>{jest.mocked(changeUserPassword).mockReset();jest.mocked(revokeRefreshSession).mockReset();jest.spyOn(console,"warn").mockImplementation(()=>undefined);jest.spyOn(diagnostics,"recordAuthRejection").mockImplementation(diagnostics.createAuthRejectionReporter(()=>0));});
afterEach(()=>jest.restoreAllMocks());
async function request(path:string,payload:unknown){const app=Fastify();await app.register(routes,{prefix:"/auth",rateLimiter:{consume:async()=>({allowed:true,count:1,resetAfterMs:1000,limit:20,remaining:19,backend:"local"})}});try{return await app.inject({method:"POST",url:`/auth/${path}`,payload:payload as any,headers:{cookie:privateValue}});}finally{await app.close();}}
function diagnostic(code:string,response:any){expect(console.warn).toHaveBeenCalledWith(JSON.stringify({event:"authentication_rejected",code,suppressed:0}));expect(JSON.stringify(jest.mocked(console.warn).mock.calls)+response.body).not.toContain(privateValue);}
it.each(["schema","incorrect","unauthorized","internal"])("password %s rejection remains sanitized and statically classified",async kind=>{
 if(kind!=="schema")jest.mocked(changeUserPassword).mockRejectedValue(Error(kind==="incorrect"?"Current password is incorrect":kind==="unauthorized"?"Unauthorized":privateValue));
 const response=await request("change-password",kind==="schema"?{currentPassword:privateValue,newPassword:"x"}:{currentPassword:privateValue,newPassword:"synthetic-new-password"});
 expect(response.statusCode).toBe(kind==="internal"?500:kind==="unauthorized"?401:400);diagnostic(kind==="internal"?"PASSWORD_CHANGE_UNAVAILABLE":"PASSWORD_CHANGE_REJECTED",response);if(kind==="schema")expect(changeUserPassword).not.toHaveBeenCalled();
});
it("logout invalid input emits no submitted token and never calls revocation",async()=>{const response=await request("logout",{refreshToken:"short"});expect(response.statusCode).toBe(400);expect(revokeRefreshSession).not.toHaveBeenCalled();diagnostic("LOGOUT_INPUT_REJECTED",response);});
it("logout internal exception is sanitized and cannot claim confirmed revocation",async()=>{jest.mocked(revokeRefreshSession).mockRejectedValue(Error(privateValue));const response=await request("logout",{refreshToken:privateValue});expect(response.statusCode).toBe(500);expect(response.json()).toEqual({error:"Logout failed"});diagnostic("LOGOUT_UNAVAILABLE",response);});
it("successful password and indistinguishable no-op logout preserve response contracts without rejection diagnostics",async()=>{
 jest.mocked(changeUserPassword).mockResolvedValue(undefined);jest.mocked(revokeRefreshSession).mockResolvedValue(undefined);
 expect((await request("change-password",{currentPassword:privateValue,newPassword:"synthetic-new-password"})).json()).toEqual({message:"Password updated successfully"});expect((await request("logout",{refreshToken:privateValue})).json()).toEqual({ok:true});expect(console.warn).not.toHaveBeenCalled();
});

it.each(["invalid-json","empty-json","media","oversized"])("actual parser %s rejects before credential work without input diagnostics",async kind=>{
 const app=Fastify();await app.register(routes,{prefix:"/auth",rateLimiter:{consume:async()=>({allowed:true,count:1,resetAfterMs:1000,limit:20,remaining:19,backend:"local"})}});
 try{
  const response=await app.inject({method:"POST",url:"/auth/change-password",headers:{"content-type":kind==="media"?"application/synthetic-unsupported":"application/json",cookie:privateValue},payload:kind==="empty-json"?"":kind==="oversized"?JSON.stringify({password:privateValue,pad:"x".repeat(17000)}):'{"password":"'+privateValue+'"'});
  expect(response.statusCode).toBe(kind==="media"?415:kind==="oversized"?413:400);diagnostic("AUTH_INPUT_REJECTED",response);expect(changeUserPassword).not.toHaveBeenCalled();expect(revokeRefreshSession).not.toHaveBeenCalled();
 }finally{await app.close();}
});
