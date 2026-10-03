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
beforeEach(() => { jest.clearAllMocks(); process.env.REFRESH_TOKEN_SECRET = secret; db.userRefreshSession.updateMany.mockReset().mockResolvedValue({ count: 1 }); });
afterEach(() => { delete process.env.REFRESH_TOKEN_SECRET; expect(db.userRefreshSession.create).not.toHaveBeenCalled(); expect(db.userRefreshSession.findUnique).not.toHaveBeenCalled(); expect(db.$transaction).not.toHaveBeenCalled(); });
it("exact signed refresh possession is repeated with authoritative selected company at the actual update", async () => {
  const raw = token(); await revokeRefreshSession(raw); expect(db.userRefreshSession.updateMany.mock.calls[0][0]).toEqual({ where: { id: claims.sid, userId: claims.id, tokenHash: createHash("sha256").update(raw).digest("hex"), revokedAt: null, tenantId: claims.tenantId, tenantMembershipId: claims.tenantMembershipId, companyMembershipId: claims.companyMembershipId, companyMembership: { is: { id: claims.companyMembershipId, userId: claims.id, tenantId: claims.tenantId, tenantMembershipId: claims.tenantMembershipId, companyId: claims.companyId } } }, data: { revokedAt: expect.any(Date) } });
});
it.each(["", "not-a-token", jwt.sign(claims, "synthetic-other-key"), token({ tokenType: "access" }), token({ tokenType: undefined }), token({ sid: "invalid" }), token({ id: false }), token({ tenantId: undefined }), token({ tenantMembershipId: undefined }), token({ companyMembershipId: undefined }), token({ companyId: undefined })])("unverified/wrong-purpose/partial context produces no session mutation", async raw => { await revokeRefreshSession(raw); expect(db.userRefreshSession.updateMany).not.toHaveBeenCalled(); });
it("missing or conflicting stored token returns no protected data or fallback success write", async () => { db.userRefreshSession.updateMany.mockResolvedValue({ count: 0 }); expect(await revokeRefreshSession(token())).toBeUndefined(); expect(db.userRefreshSession.updateMany).toHaveBeenCalledTimes(1); });
it("duplicate exact requests remain conditional, without replacement or broader user revocation", async () => { db.userRefreshSession.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 }); await Promise.all([1, 2, 3].map(() => revokeRefreshSession(token()))); for (const [query] of db.userRefreshSession.updateMany.mock.calls) { expect(query.where).toHaveProperty("id", claims.sid); expect(query.where).toHaveProperty("revokedAt", null); expect(query.where.tokenHash).toHaveLength(64); } });
