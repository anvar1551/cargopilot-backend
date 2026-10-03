jest.mock("../../src/config/prismaClient", () => ({ __esModule:true, default:require("./fixtures").database }));
jest.mock("../../src/config/redis", () => ({ getRedisClient:jest.fn(async()=>null),getRedisPrefix:()=>"test",withRedisTimeout:async(_name:string,work:()=>Promise<unknown>)=>work() }));
jest.mock("../../src/modules/identity-access/application/auth.service",()=>({
 loginUser:jest.fn(), refreshUserSession:jest.fn(), revokeRefreshSession:jest.fn(), changeUserPassword:jest.fn(),listUsersForCompany:jest.fn(),
 InvalidMembershipSelectionError:class extends Error {code="INVALID_MEMBERSHIP_SELECTION";constructor(){super("Invalid membership selection");}},
 MembershipSelectionRequiredError:class extends Error {code="MEMBERSHIP_SELECTION_REQUIRED";memberships=[{companyMembershipId:"synthetic-choice"}];},
}));
jest.mock("../../src/modules/identity-access/transport/auth-rejection-diagnostics",()=>({
 ...jest.requireActual("../../src/modules/identity-access/transport/auth-rejection-diagnostics"),recordAuthRejection:jest.fn(),
}));
import Fastify from "fastify";
import routes from "../../src/modules/identity-access/transport/fastify-routes";
import {createAuthRejectionReporter,recordAuthRejection,AuthRejectionCode} from "../../src/modules/identity-access/transport/auth-rejection-diagnostics";
import {loginUser,refreshUserSession,InvalidMembershipSelectionError,MembershipSelectionRequiredError} from "../../src/modules/identity-access/application/auth.service";
import {database} from "./fixtures";

const codes:AuthRejectionCode[]=["LOGIN_CREDENTIALS_REJECTED","LOGIN_SELECTION_REJECTED","LOGIN_UNAVAILABLE","REFRESH_REJECTED","REFRESH_UNAVAILABLE","AUTH_ADMISSION_LIMITED","AUTH_ADMISSION_UNAVAILABLE"];
describe("bounded rejection diagnostic helper (unit)",()=>{
 it("emits only a fixed immutable projection and rejects unknown runtime labels",()=>{
  const emit=createAuthRejectionReporter(()=>0),sink=jest.fn();emit("LOGIN_CREDENTIALS_REJECTED",sink);emit("private-token@example.test" as any,sink);
  expect(sink).toHaveBeenCalledTimes(1);expect(sink).toHaveBeenCalledWith({event:"authentication_rejected",code:"LOGIN_CREDENTIALS_REJECTED",suppressed:0});expect(Object.isFrozen(sink.mock.calls[0][0])).toBe(true);
 });
 it("limits each code and the whole process window without attacker-keyed state",()=>{
  const emit=createAuthRejectionReporter(()=>0),sink=jest.fn();for(let i=0;i<5000;i++)for(const code of codes)emit(code,sink);
  expect(sink).toHaveBeenCalledTimes(12);for(const code of codes)expect(sink.mock.calls.filter(([value])=>value.code===code).length).toBeLessThanOrEqual(2);
 });
 it("renews a monotonic minute window and reports a saturated suppressed count",()=>{
  let now=0;const emit=createAuthRejectionReporter(()=>now),sink=jest.fn();for(let i=0;i<1_000_005;i++)emit(codes[0],sink);
  expect(sink).toHaveBeenCalledTimes(2);now=60000;emit(codes[0],sink);expect(sink).toHaveBeenLastCalledWith({event:"authentication_rejected",code:codes[0],suppressed:1_000_000});
  emit(codes[0],sink);expect(sink.mock.calls[3][0].suppressed).toBe(0);
 });
 it("clock rollback cannot reset an exhausted budget",()=>{
  let now=0;const emit=createAuthRejectionReporter(()=>now),sink=jest.fn();emit(codes[0],sink);emit(codes[0],sink);now=-60000;emit(codes[0],sink);now=59999;emit(codes[0],sink);expect(sink).toHaveBeenCalledTimes(2);
 });
 it("sink failure remains bounded and cannot alter authorization handling",()=>{
  const emit=createAuthRejectionReporter(()=>0),sink=jest.fn(()=>{throw Error("synthetic sink failure");});expect(()=>{for(let i=0;i<20;i++)emit(codes[0],sink);}).not.toThrow();expect(sink).toHaveBeenCalledTimes(2);
 });
});

describe("auth rejection boundaries (Fastify injection, mocked business/storage)",()=>{
 afterEach(()=>{jest.restoreAllMocks();});
 beforeEach(()=>{jest.clearAllMocks();jest.mocked(recordAuthRejection).mockImplementation(createAuthRejectionReporter(()=>0));});
 async function appFor(decision:"allowed"|"limited"|"unavailable"="allowed"){
  const app=Fastify();const warn=jest.spyOn(console,"warn").mockImplementation(()=>undefined);
  const consume=jest.fn(async()=>{if(decision==="unavailable")throw Error("synthetic private backend details");return {count:1,resetAfterMs:1000,allowed:decision==="allowed",limit:2,remaining:1,backend:"local" as const};});
  await app.register(routes,{prefix:"/auth",rateLimiter:{consume}});return {app,warn,consume};
 }
 const sensitive="synthetic-sensitive-password-token-cookie@example.test";
 it.each([
  ["Invalid email or password",401,"LOGIN_CREDENTIALS_REJECTED"],
  ["No active tenant membership found",401,"LOGIN_CREDENTIALS_REJECTED"],
  [sensitive,500,"LOGIN_UNAVAILABLE"],
 ] as const)("login rejection %s emits only static classification",async(message,status,code)=>{
  jest.mocked(loginUser).mockRejectedValue(Error(message));const {app,warn}=await appFor();try{
   const response=await app.inject({method:"POST",url:"/auth/login",payload:{email:sensitive,password:sensitive},headers:{authorization:sensitive,cookie:sensitive}});
   expect(response.statusCode).toBe(status);expect(warn).toHaveBeenCalledTimes(1);expect(warn.mock.calls[0]).toEqual([JSON.stringify({event:"authentication_rejected",code,suppressed:0})]);
   expect(JSON.stringify(warn.mock.calls)+response.body).not.toContain(sensitive);expect(database.userRefreshSession.create).not.toHaveBeenCalled();
  }finally{await app.close();}
 });
 it("invalid selection is classified without selector disclosure or a session",async()=>{
  jest.mocked(loginUser).mockRejectedValue(new InvalidMembershipSelectionError());const {app,warn}=await appFor();try{
   expect((await app.inject({method:"POST",url:"/auth/login",payload:{email:sensitive,password:sensitive,companyMembershipId:sensitive}})).statusCode).toBe(403);
   expect(JSON.parse(warn.mock.calls[0][0] as string)).toEqual({event:"authentication_rejected",code:"LOGIN_SELECTION_REJECTED",suppressed:0});expect(database.userRefreshSession.create).not.toHaveBeenCalled();
  }finally{await app.close();}
 });
 it("expected verified selection-required and successful login are not rejections",async()=>{
  const {app,warn}=await appFor();try{
   jest.mocked(loginUser).mockRejectedValueOnce(new MembershipSelectionRequiredError([]));
   const selection=await app.inject({method:"POST",url:"/auth/login",payload:{email:sensitive,password:sensitive}});expect(selection.statusCode).toBe(409);expect(selection.json().code).toBe("MEMBERSHIP_SELECTION_REQUIRED");
   jest.mocked(loginUser).mockResolvedValueOnce({accessToken:"synthetic-confirmed"} as any);expect((await app.inject({method:"POST",url:"/auth/login",payload:{email:sensitive,password:sensitive}})).statusCode).toBe(200);expect(warn).not.toHaveBeenCalled();
  }finally{await app.close();}
 });
 it.each(["login","refresh"])("%s limiter rejection prevents business admission and retains status/retry contract",async path=>{
  const {app,warn}=await appFor("limited");try{
   const result=await app.inject({method:"POST",url:`/auth/${path}`,payload:{email:sensitive,password:sensitive,refreshToken:sensitive}});
   expect(result.statusCode).toBe(429);expect(result.headers["retry-after"]).toBe("1");expect(loginUser).not.toHaveBeenCalled();expect(refreshUserSession).not.toHaveBeenCalled();expect(database.userRefreshSession.create).not.toHaveBeenCalled();
   expect(JSON.parse(warn.mock.calls[0][0] as string)).toEqual({event:"authentication_rejected",code:"AUTH_ADMISSION_LIMITED",suppressed:0});expect(JSON.stringify(warn.mock.calls)+result.body).not.toContain(sensitive);
  }finally{await app.close();}
 });
 it("admission storage failure emits no backend exception and runs no authentication",async()=>{
  const {app,warn}=await appFor("unavailable");try{expect((await app.inject({method:"POST",url:"/auth/login",payload:{password:sensitive}})).statusCode).toBe(503);expect(loginUser).not.toHaveBeenCalled();expect(JSON.parse(warn.mock.calls[0][0] as string)).toEqual({event:"authentication_rejected",code:"AUTH_ADMISSION_UNAVAILABLE",suppressed:0});expect(JSON.stringify(warn.mock.calls)).not.toContain("backend details");}finally{await app.close();}
 });
 it.each(["Invalid refresh token",sensitive])("refresh failure %s never exposes submitted or exception values",async message=>{
  jest.mocked(refreshUserSession).mockRejectedValue(Error(message));const {app,warn}=await appFor();try{
   const response=await app.inject({method:"POST",url:"/auth/refresh",payload:{refreshToken:sensitive},headers:{cookie:sensitive}});expect(response.statusCode).toBe(message===sensitive?500:401);
   expect(JSON.parse(warn.mock.calls[0][0] as string)).toEqual({event:"authentication_rejected",code:message===sensitive?"REFRESH_UNAVAILABLE":"REFRESH_REJECTED",suppressed:0});expect(JSON.stringify(warn.mock.calls)+response.body).not.toContain(sensitive);expect(database.userRefreshSession.create).not.toHaveBeenCalled();
  }finally{await app.close();}
 });
 it("invalid refresh shape is rejected before service work",async()=>{
  const {app,warn}=await appFor();try{expect((await app.inject({method:"POST",url:"/auth/refresh",payload:{refreshToken:"short"}})).statusCode).toBe(401);expect(refreshUserSession).not.toHaveBeenCalled();expect(JSON.parse(warn.mock.calls[0][0] as string)).toEqual({event:"authentication_rejected",code:"REFRESH_REJECTED",suppressed:0});}finally{await app.close();}
 });
});
