// Actual JWT, Socket.IO, Engine.IO and ws; synthetic database responses only.
// No dotenv, application startup, Prisma instance, Redis or external endpoint.
jest.mock("../../src/config/prismaClient", () => ({
  __esModule: true, default: require("./fixtures").database,
}));
import { createServer } from "http";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { database as db, databaseCalls } from "./fixtures";
import { clearIdentityAccessCacheForUser } from "../../src/modules/identity-access/access-control";
import { initRealtimeHub, emitDriverOrderUpdate } from "../../src/modules/realtime-core/realtimeHub";
const WebSocket = require("ws");
const secret = "synthetic-jwt-socket-only-32-characters";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const userId = id(1), orderId = id(20);
const contexts = [0, 1, 2].map(n => ({
  id: userId, sid: id(2+n), tenantId: id(n === 1 ? 6 : 5),
  tenantMembershipId: id(n === 1 ? 8 : 7), companyId: id(10+n),
  companyMembershipId: id(14+n), membershipId: id(14+n), tokenType: "access" as const,
}));
let records: any[];
let revoked: Set<string>;
type Wire = { ws: any; packets: string[]; closed: Promise<void> };
const wires: Wire[] = [];
const http = createServer();
let io: Server, base: string;
const oldSecret = process.env.JWT_SECRET;
let warnings: jest.SpyInstance;

function record(c: typeof contexts[number]) {
  return {
    id: c.membershipId, userId, status: "active", companyId: c.companyId,
    tenantId: c.tenantId, tenantMembershipId: c.tenantMembershipId, branchId: null,
    tenant: { id: c.tenantId, status: "active" },
    tenantMembership: { id: c.tenantMembershipId, userId, tenantId: c.tenantId, status: "active" },
    company: { id: c.companyId, tenantId: c.tenantId, isActive: true }, branch: null,
    user: { id: userId, name: "Synthetic Driver", email: "synthetic@example.test", warehouseId: null, customerEntityId: null },
    scopes: [{ scopeType: "company", scopeRefId: c.companyId }],
    roles: [{ role: { code: "driver", rolePermissions: [{ permission: { key: "drivers.telemetry" } }] } }],
  };
}
function token(patch = {}, key = secret) {
  return jwt.sign({ ...contexts[0], ...patch }, key, { expiresIn: 60 });
}
async function until(predicate: () => boolean, milliseconds = 3000) {
  const deadline = Date.now()+milliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw Error("Synthetic transport deadline");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function connect(value: string): Promise<Wire> {
  const ws = new WebSocket(base.replace("http:", "ws:")+"/socket.io/?EIO=4&transport=websocket");
  const packets: string[] = [];
  const closed = new Promise<void>(resolve => ws.once("close", resolve));
  const wire = { ws, packets, closed }; wires.push(wire);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { ws.terminate(); reject(Error("Synthetic connect deadline")); }, 3000);
    const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
    ws.on("error", () => finish(Error("Synthetic transport error")));
    ws.on("message", (data: Buffer) => {
      const packet = data.toString(); packets.push(packet);
      if (packet.startsWith("0")) ws.send("40"+JSON.stringify({ token: value }));
      else if (packet === "2") ws.send("3");
      else if (packet.startsWith("44")) { ws.terminate(); finish(Error("Unauthorized socket")); }
      else if (packet.startsWith("42") && JSON.parse(packet.slice(2))[0] === "driver:realtime:ready") finish();
    });
  });
  return wire;
}
const event = () => ({ orderId, status: "assigned", updatedAt: "2026-10-04T12:00:00.000Z" });
const deliveries = (w: Wire) => w.packets.filter(p => p.startsWith('42["driver:order-updated"'));
const request = (url: string, init?: RequestInit) => fetch(base+url, { ...init, signal: AbortSignal.timeout(3000) });

beforeAll(async () => {
  process.env.JWT_SECRET = secret;
  warnings = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  io = initRealtimeHub(http, ["http://127.0.0.1"]);
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as any).port}`;
});
beforeEach(() => {
  databaseCalls.length = 0;
  records = contexts.map(record); revoked = new Set(); clearIdentityAccessCacheForUser(userId);
  db.$transaction.mockReset().mockImplementation(async (work: any) => work(db));
  db.$executeRaw.mockReset().mockResolvedValue(0);
  db.$queryRaw.mockReset().mockImplementation(async (sql: any) => {
    const c = contexts.find(c => sql.values[0] === c.sid);
    if (!c || ![c.id,c.tenantId,c.tenantMembershipId,c.companyMembershipId,c.companyId].every(v => sql.values.includes(v))) return [];
    return [{ id: c.sid, userId, tenantId: c.tenantId, tenantMembershipId: c.tenantMembershipId,
      companyMembershipId: c.companyMembershipId, rotationDepth: 0, replacementDepth: null,
      replacedBySessionId: null, revokedAt: revoked.has(c.sid) ? new Date() : null,
      expiresAt: new Date(Date.now()+60000), hop: 0 }];
  });
  db.companyMembership.findFirst.mockReset().mockImplementation(async (args: any) => records.find(r => r.id === args.where.id && r.userId === args.where.userId) ?? null);
  db.companyMembership.findUnique.mockReset().mockResolvedValue(records[0]);
  db.order.findUnique.mockReset().mockResolvedValue({ id: orderId, tenantId: contexts[0].tenantId, ownerOrgId: contexts[0].companyId, assignedDriverId: userId });
});
afterEach(async () => {
  for (const wire of wires.splice(0)) {
    wire.ws.terminate();
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([wire.closed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Synthetic close deadline")), 3000); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  await until(() => io.sockets.sockets.size === 0);
  expect(databaseCalls.filter(call => /^(create|update|delete|upsert)/.test(call.method))).toEqual([]);
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Synthetic server cleanup deadline")), 3000);
    io.close(() => { clearTimeout(timer); resolve(); });
  });
  expect(http.listening).toBe(false);
  warnings.mockRestore();
  if (oldSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret;
});

it.each(["HS256", "HS384", "HS512"] as const)("JWT %s retains signature and explicit issuer/audience validation", algorithm => {
  const signed = jwt.sign({ tokenType: "access" }, secret, { algorithm, issuer: "synthetic-issuer", audience: "synthetic-audience", expiresIn: 60 });
  expect(jwt.verify(signed, secret, { algorithms: [algorithm], issuer: "synthetic-issuer", audience: "synthetic-audience" })).toMatchObject({ tokenType: "access" });
  expect(() => jwt.verify(signed, "wrong-synthetic-key")).toThrow();
  expect(() => jwt.verify(signed, secret, { issuer: "other" })).toThrow();
  expect(() => jwt.verify(signed, secret, { audience: "other" })).toThrow();
  expect(() => jwt.verify(signed, secret, { algorithms: ["RS256"] })).toThrow();
});
it("real websocket delivery separates tenant and same-tenant company sessions", async () => {
  const a = await connect(token()), b = await connect(token(contexts[1])), c = await connect(token(contexts[2]));
  await emitDriverOrderUpdate(userId, event());
  await until(() => deliveries(a).length === 1);
  // A per-connection ordered barrier proves the negative recipients drained
  // preceding traffic; absence is not asserted before their network callbacks.
  for (const socket of io.sockets.sockets.values()) socket.emit("dependency:test-barrier");
  await until(() => [a,b,c].every(w => w.packets.some(p => p.startsWith('42["dependency:test-barrier"'))));
  expect(deliveries(b)).toHaveLength(0); expect(deliveries(c)).toHaveLength(0);
});
it.each([{ tokenType: "refresh" }, { companyId: id(99) }, { tenantId: id(99) }, { membershipId: id(99) }])("real handshake rejects purpose/conflicting selected context %j", async patch => {
  await expect(connect(token(patch))).rejects.toThrow("Unauthorized");
});
it("real handshake rejects invalid signatures without session queries", async () => {
  db.$queryRaw.mockClear();
  await expect(connect(token({}, "wrong-synthetic-key"))).rejects.toThrow("Unauthorized");
  expect(db.$queryRaw).not.toHaveBeenCalled();
});
it.each(["session", "membership", "permission"])("existing socket loses protected delivery after %s revocation", async kind => {
  const a = await connect(token());
  if (kind === "session") revoked.add(contexts[0].sid);
  if (kind === "membership") records[0].status = "suspended";
  if (kind === "permission") records[0].roles = [];
  await emitDriverOrderUpdate(userId, event());
  await until(() => a.ws.readyState === WebSocket.CLOSED);
  expect(deliveries(a)).toHaveLength(0);
});
it("real polling supports authorized handshake and closes the owned transport", async () => {
  const open = await request("/socket.io/?EIO=4&transport=polling");
  expect(open.status).toBe(200);
  const sid = JSON.parse((await open.text()).slice(1)).sid;
  const path = `/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(sid)}`;
  try {
    expect((await request(path, { method: "POST", headers: { "content-type": "text/plain" }, body: "40"+JSON.stringify({ token: token() }) })).status).toBe(200);
    const response = await request(path);
    expect(await response.text()).toContain("driver:realtime:ready");
  } finally { await request(path, { method: "POST", headers: { "content-type": "text/plain" }, body: "1" }); }
});
it("real Engine.IO rejects an unsupported protocol before authenticated admission", async () => {
  db.$queryRaw.mockClear();
  expect((await request("/socket.io/?EIO=999&transport=polling")).status).toBe(400);
  expect(db.$queryRaw).not.toHaveBeenCalled();
});
