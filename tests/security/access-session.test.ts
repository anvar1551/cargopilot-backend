jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
import { database as db } from "./fixtures";
import { hasLiveAccessSession, isBoundAccessSession } from "../../src/modules/identity-access/application/access-session";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const claims: any = { id: id(1), sid: id(2), tenantId: id(3), tenantMembershipId: id(4), companyMembershipId: id(5), membershipId: id(5), companyId: id(6), tokenType: "access", exp: Math.floor(Date.now()/1000)+3600 };
const root = () => ({ id: claims.sid, userId: claims.id, tenantId: claims.tenantId, tenantMembershipId: claims.tenantMembershipId, companyMembershipId: claims.companyMembershipId,
  rotationDepth: 0, replacementDepth: null, replacedBySessionId: null, revokedAt: null, expiresAt: new Date(Date.now()+3600000), hop: 0 });
beforeEach(() => { db.$transaction.mockReset().mockImplementation(async (fn: any) => fn(db)); db.$executeRaw.mockReset().mockResolvedValue(0); db.$queryRaw.mockReset().mockResolvedValue([root()]); });
it("live exact root uses bounded readonly parameterized current ownership query without hashes or writes", async () => {
  expect(await hasLiveAccessSession(claims)).toBe(true); const sql = db.$queryRaw.mock.calls[0][0];
  for (const id of [claims.id,claims.sid,claims.tenantId,claims.tenantMembershipId,claims.companyMembershipId,claims.companyId]) expect(sql.values).toContain(id);
  expect(sql.text).toContain("WITH RECURSIVE"); expect(sql.text).toContain("m.status='active'"); expect(sql.text).toContain("tm.status='active'"); expect(sql.text).toContain('o."isActive"=true'); expect(sql.text).not.toMatch(/tokenHash|password|UPDATE|INSERT/);
  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel:"ReadCommitted", maxWait:2000, timeout:10000 });
});
it.each([{ sid:undefined },{sid:"invalid"},{tokenType:"refresh"},{membershipId:id(9)},{tenantId:null},{exp:undefined},{exp:0},{exp:1.2}])("unbound/malformed/expired claims %j deny before database admission", async patch => { const c={...claims,...patch}; expect(isBoundAccessSession(c)).toBe(false); expect(await hasLiveAccessSession(c)).toBe(false); expect(db.$transaction).not.toHaveBeenCalled(); });
it("recorded rotation preserves access only to a live accepted successor", async () => { const r=root(); db.$queryRaw.mockResolvedValue([{...r,revokedAt:new Date(),replacedBySessionId:id(7),replacementDepth:1},{...r,id:id(7),rotationDepth:1,hop:1}]); expect(await hasLiveAccessSession(claims)).toBe(true); });
it.each([{ revokedAt:new Date() },{expiresAt:new Date(0)},{tenantId:id(9)},{tenantMembershipId:id(9)},{companyMembershipId:id(9)},{userId:id(9)},{id:id(9)},{rotationDepth:257},{hop:1},{replacementDepth:1},{replacedBySessionId:id(8)}])("revoked/conflicting/missing successor root %j denies", async patch => { db.$queryRaw.mockResolvedValue([{...root(),...patch}]); expect(await hasLiveAccessSession(claims)).toBe(false); });
it.each([{replacementDepth:2},{revokedAt:null},{replacedBySessionId:id(9)}])("malformed predecessor %j cannot bridge access to another live record", async patch => { const r=root(); db.$queryRaw.mockResolvedValue([{...r,revokedAt:new Date(),replacedBySessionId:id(7),replacementDepth:1,...patch},{...r,id:id(7),rotationDepth:1,hop:1}]); expect(await hasLiveAccessSession(claims)).toBe(false); });
it("missing and cyclic chains deny; database errors never become positive cache evidence", async () => { db.$queryRaw.mockResolvedValue([]); expect(await hasLiveAccessSession(claims)).toBe(false); const r=root(); db.$queryRaw.mockResolvedValue([r,{...r,hop:1}]); expect(await hasLiveAccessSession(claims)).toBe(false); db.$queryRaw.mockRejectedValue(new Error("synthetic DB unavailable")); await expect(hasLiveAccessSession(claims)).rejects.toThrow("unavailable"); });
it("admission bounds underlying pending transactions, not just HTTP wait time, and releases permits",async()=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});db.$transaction.mockImplementation(async(fn:any)=>{await gate;return fn(db);});
  const pending=Array.from({length:32},()=>hasLiveAccessSession(claims));
  try{expect(await hasLiveAccessSession(claims)).toBe(false);expect(db.$transaction).toHaveBeenCalledTimes(32);expect(db.$queryRaw).not.toHaveBeenCalled();}
  finally{release();expect((await Promise.all(pending)).every(Boolean)).toBe(true);}
  expect(await hasLiveAccessSession(claims)).toBe(true);
});
