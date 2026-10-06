jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
jest.mock("../../src/config/redis", () => ({ getRedisClient: jest.fn(async () => null), getRedisPrefix: () => "test", withRedisTimeout: async (_name: string, work: any) => work() }));
import jwt from "jsonwebtoken";
import { createHash } from "crypto";
import { database as db } from "./fixtures";
import { revokeRefreshSession } from "../../src/modules/identity-access/application/auth.service";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const claims = { id: id(1), sid: id(2), tenantId: id(3), tenantMembershipId: id(4), companyMembershipId: id(5), companyId: id(6), tokenType: "refresh" };
const secret = "synthetic-logout-only";
const token = (patch: any = {}) => jwt.sign({ ...claims, ...patch }, secret, { expiresIn: "1h" });
beforeEach(() => { jest.clearAllMocks(); process.env.REFRESH_TOKEN_SECRET = secret; db.credentialSecurityEvent.create.mockReset().mockResolvedValue({}); db.userRefreshSession.updateMany.mockReset().mockResolvedValue({ count: 1 }); db.userRefreshSession.findFirst.mockReset().mockResolvedValue({ id: claims.sid, userId: claims.id, tenantId: claims.tenantId, tenantMembershipId: claims.tenantMembershipId, companyMembershipId: claims.companyMembershipId, companyMembership:{companyId:claims.companyId} }); db.$executeRaw.mockReset().mockResolvedValue(0); db.$queryRaw.mockReset().mockImplementation(async (sql: any) => sql.text.includes('FOR KEY SHARE') ? [{id:sql.values[0]}] : sql.text.includes("pg_advisory") ? [] : [{ id: claims.sid, userId: claims.id, tenantId: claims.tenantId, tenantMembershipId: claims.tenantMembershipId, companyMembershipId: claims.companyMembershipId, rotationDepth: 0, replacementDepth: null, replacedBySessionId: null, revokedAt: null }]); db.$transaction.mockReset().mockImplementation(async (fn: any) => fn(db)); });
afterEach(() => { delete process.env.REFRESH_TOKEN_SECRET; expect(db.userRefreshSession.create).not.toHaveBeenCalled(); expect(db.userRefreshSession.findUnique).not.toHaveBeenCalled(); });
it("exact signed refresh possession is repeated with authoritative selected company at the actual update", async () => {
  const raw = token(); await revokeRefreshSession(raw);
  const hash = createHash("sha256").update(raw).digest("hex");
  expect(db.userRefreshSession.findFirst.mock.calls[0][0].where).toEqual({ id: claims.sid, userId: claims.id, tokenHash: hash, tenantId: claims.tenantId, tenantMembershipId: claims.tenantMembershipId, companyMembershipId: claims.companyMembershipId, companyMembership: { is: { id: claims.companyMembershipId, userId: claims.id, tenantId: claims.tenantId, tenantMembershipId: claims.tenantMembershipId, companyId: claims.companyId } } });
  const loaded = db.$queryRaw.mock.calls[3][0]; expect(loaded.text).toContain('FOR UPDATE OF s'); expect(loaded.values).toContain(hash);
  expect(db.userRefreshSession.updateMany.mock.calls[0][0].where).toMatchObject({ id: { in: [claims.sid] }, userId: claims.id, revokedAt: null, tenantId: claims.tenantId, companyMembershipId: claims.companyMembershipId });
});
it.each(["", "not-a-token", jwt.sign(claims, "synthetic-other-key"), token({ tokenType: "access" }), token({ tokenType: undefined }), token({ sid: "invalid" }), token({ id: false }), token({ tenantId: undefined }), token({ tenantMembershipId: undefined }), token({ companyMembershipId: undefined }), token({ companyId: undefined })])("unverified/wrong-purpose/partial context produces no session mutation", async raw => { await revokeRefreshSession(raw); expect(db.userRefreshSession.updateMany).not.toHaveBeenCalled(); expect(db.$transaction).not.toHaveBeenCalled(); });
it("missing or conflicting stored token returns no protected data or fallback success write", async () => { db.userRefreshSession.findFirst.mockResolvedValue(null); expect(await revokeRefreshSession(token())).toBeUndefined(); expect(db.userRefreshSession.updateMany).not.toHaveBeenCalled(); });
it("duplicate exact requests remain conditional, without replacement or broader user revocation", async () => { db.userRefreshSession.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 }); await Promise.all([1, 2, 3].map(() => revokeRefreshSession(token()))); for (const [query] of db.userRefreshSession.updateMany.mock.calls) { expect(query.where.id).toEqual({ in: [claims.sid] }); expect(query.where).toHaveProperty("revokedAt", null); expect(query.where.tenantId).toBe(claims.tenantId); } });

it("accepted logout audit contains only stored owner fields, not token/hash/session or claims payload",async()=>{
 const raw=token({untrustedExtra:"synthetic-private"});await revokeRefreshSession(raw);
 expect(db.credentialSecurityEvent.create).toHaveBeenCalledWith({data:{actorUserId:claims.id,tenantId:claims.tenantId,tenantMembershipId:claims.tenantMembershipId,companyId:claims.companyId,companyMembershipId:claims.companyMembershipId,action:"LOGOUT_ACCEPTED"}});
 expect(JSON.stringify(db.credentialSecurityEvent.create.mock.calls)).not.toContain("synthetic-private");
});
it("conditional no-op logout creates no duplicate accepted event",async()=>{
 db.userRefreshSession.updateMany.mockResolvedValue({count:0});await revokeRefreshSession(token());expect(db.credentialSecurityEvent.create).not.toHaveBeenCalled();
});
it("logout audit failure rejects; transactional rollback is verified separately",async()=>{
 db.credentialSecurityEvent.create.mockRejectedValue(Error("synthetic logout audit failure"));await expect(revokeRefreshSession(token())).rejects.toThrow("audit failure");
});
it("conflicting stored company cannot supply accepted audit ownership",async()=>{
 db.userRefreshSession.findFirst.mockResolvedValue({id:claims.sid,userId:claims.id,tenantId:claims.tenantId,tenantMembershipId:claims.tenantMembershipId,companyMembershipId:claims.companyMembershipId,companyMembership:{companyId:id(90)}});
 await expect(revokeRefreshSession(token())).rejects.toThrow("unavailable");expect(db.userRefreshSession.updateMany).not.toHaveBeenCalled();expect(db.credentialSecurityEvent.create).not.toHaveBeenCalled();
});
