jest.mock("../../src/config/prismaClient", () => ({
  __esModule: true,
  default: require("./fixtures").database,
}));

jest.mock("../../src/modules/notifications-core/application/notificationService", () => ({
  createUserNotification: jest.fn(),
  countUnreadUserNotifications: jest.fn(),
}));

jest.mock("socket.io", () => {
  const deliveries: Array<{ room: string; event: string; payload: unknown }> = [];
  const server = {
    use: jest.fn(),
    on: jest.fn(),
    to: jest.fn((room: string) => ({
      emit: (event: string, payload: unknown) => deliveries.push({ room, event, payload }),
    })),
    sockets: { sockets: new Map() },
    engine: { on: jest.fn() },
  };
  return { Server: jest.fn(() => server), __mockServer: server, __deliveries: deliveries };
});
jest.mock("../../src/modules/identity-access/application/access-session", () => ({
  ...jest.requireActual("../../src/modules/identity-access/application/access-session"),
  hasLiveAccessSession: jest.fn(async () => true),
}));

import { database } from "./fixtures";
import { clearIdentityAccessCacheForUser } from "../../src/modules/identity-access/access-control";
import {
  emitDriverNotification,
  emitDriverOrderUpdate,
  emitDriverUnreadCount,
  initRealtimeHub,
} from "../../src/modules/realtime-core/realtimeHub";
import { createUserNotification } from "../../src/modules/notifications-core/application/notificationService";
import { countUnreadUserNotifications } from "../../src/modules/notifications-core/application/notificationService";
import { hasLiveAccessSession } from "../../src/modules/identity-access/application/access-session";

const socketIoMock = jest.requireMock("socket.io") as {
  __mockServer: {
    use: jest.Mock;
    on: jest.Mock;
    to: jest.Mock;
    sockets: { sockets: Map<string, any> };
  };
  __deliveries: Array<{ room: string; event: string; payload: unknown }>;
};

const ids = {
  user: "10000000-0000-4000-8000-000000000001",
  tenantA: "20000000-0000-4000-8000-000000000001",
  tenantB: "20000000-0000-4000-8000-000000000002",
  tenantMembershipA: "30000000-0000-4000-8000-000000000001",
  tenantMembershipB: "30000000-0000-4000-8000-000000000002",
  tenantMembershipSameTenant: "30000000-0000-4000-8000-000000000003",
  membershipA: "40000000-0000-4000-8000-000000000001",
  membershipB: "40000000-0000-4000-8000-000000000002",
  membershipSameTenant: "40000000-0000-4000-8000-000000000003",
  companyA: "50000000-0000-4000-8000-000000000001",
  companyB: "50000000-0000-4000-8000-000000000002",
  companySameTenant: "50000000-0000-4000-8000-000000000003",
  orderA: "60000000-0000-4000-8000-000000000001",
  orderB: "60000000-0000-4000-8000-000000000002",
};

function room(tenantId: string, membershipId: string, companyId: string) {
  return `tenant:${tenantId}:company-membership:${membershipId}:company:${companyId}:user:${ids.user}`;
}

function trackedSocket(socket: any) {
  const u = socket.data.user;
  u.tenantMembershipId ??= u.tenantId === ids.tenantB ? ids.tenantMembershipB : u.companyId === ids.companySameTenant ? ids.tenantMembershipSameTenant : ids.tenantMembershipA;
  u.sid ??= ids.orderA; u.expiresAt ??= Math.floor(Date.now()/1000)+3600;
  socket.connected = true;
  socket.emit = (event: string, payload: unknown) => socketIoMock.__deliveries.push({ room: room(u.tenantId,u.companyMembershipId,u.companyId),event,payload });
  socket.disconnect ??= jest.fn(); return socket;
}

function accessRecord(args: {
  tenantId: string;
  tenantMembershipId: string;
  membershipId: string;
  companyId: string;
  status?: string;
  permissionCodes?: string[];
}) {
  const permissionCodes = args.permissionCodes ?? ["drivers.telemetry"];
  return {
    id: args.membershipId,
    userId: ids.user,
    companyId: args.companyId,
    branchId: null,
    status: args.status ?? "active",
    tenantId: args.tenantId,
    tenantMembershipId: args.tenantMembershipId,
    tenant: { id: args.tenantId, status: "active" },
    tenantMembership: {
      id: args.tenantMembershipId,
      tenantId: args.tenantId,
      userId: ids.user,
      status: "active",
    },
    company: { id: args.companyId, tenantId: args.tenantId, isActive: true },
    branch: null,
    user: {
      id: ids.user,
      name: "Synthetic Driver",
      email: "driver@example.test",
      warehouseId: null,
      customerEntityId: null,
    },
    scopes: [{ scopeType: "company", scopeRefId: args.companyId }],
    roles: [{
      role: {
        code: "driver",
        rolePermissions: permissionCodes.map((key) => ({ permission: { key } })),
      },
    }],
  };
}

function prepareOwnedOrder(args: {
  tenantId: string;
  tenantMembershipId: string;
  membershipId: string;
  companyId: string;
  orderId: string;
  status?: string;
  permissionCodes?: string[];
}) {
  database.order.findUnique.mockResolvedValue({
    id: args.orderId,
    tenantId: args.tenantId,
    ownerOrgId: args.companyId,
    assignedDriverId: ids.user,
  });
  database.companyMembership.findUnique.mockResolvedValue({
    id: args.membershipId,
    tenantId: args.tenantId,
    tenantMembershipId: args.tenantMembershipId,
  });
  database.companyMembership.findFirst.mockResolvedValue(accessRecord(args));
}

describe("tenant-bound realtime routing (mocked emitter evidence)", () => {
  let consoleWarn: jest.SpyInstance;

  beforeAll(() => {
    consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    initRealtimeHub({} as any, []);
  });

  afterAll(() => {
    consoleWarn.mockRestore();
  });

  beforeEach(() => {
    socketIoMock.__deliveries.length = 0;
    socketIoMock.__mockServer.to.mockClear();
    socketIoMock.__mockServer.sockets.sockets.clear();
    (hasLiveAccessSession as jest.Mock).mockReset().mockResolvedValue(true);
    for (const [key, tenantId, companyId, companyMembershipId] of [
      ["a",ids.tenantA,ids.companyA,ids.membershipA],["b",ids.tenantB,ids.companyB,ids.membershipB],
      ["c",ids.tenantA,ids.companySameTenant,ids.membershipSameTenant]]) {
      socketIoMock.__mockServer.sockets.sockets.set(key, trackedSocket({ data: { user: { id:ids.user,tenantId,companyId,companyMembershipId } } }));
    }
    database.order.findUnique.mockReset();
    database.companyMembership.findUnique.mockReset();
    database.companyMembership.findFirst.mockReset();
    (createUserNotification as jest.Mock).mockReset().mockResolvedValue({
      id: "70000000-0000-4000-8000-000000000001",
      type: "order",
      title: "Order updated",
      body: "Current status: Assigned",
      createdAt: new Date("2026-09-13T12:00:00.000Z"),
      orderId: ids.orderA,
    });
    (countUnreadUserNotifications as jest.Mock).mockReset().mockResolvedValue(1);
    clearIdentityAccessCacheForUser(ids.user);
  });

  it("routes a Tenant A event only to the user's eligible Tenant A session", async () => {
    prepareOwnedOrder({ tenantId: ids.tenantA, tenantMembershipId: ids.tenantMembershipA,
      membershipId: ids.membershipA, companyId: ids.companyA, orderId: ids.orderA });

    await emitDriverOrderUpdate(ids.user, {
      orderId: ids.orderA,
      orderNumber: "SYN-A",
      status: "assigned",
      updatedAt: "2026-09-13T12:00:00.000Z",
    });

    expect(socketIoMock.__deliveries).toHaveLength(1);
    expect(socketIoMock.__deliveries[0]).toMatchObject({
      room: room(ids.tenantA, ids.membershipA, ids.companyA),
      event: "driver:order-updated",
    });
    expect(socketIoMock.__deliveries[0].room).not.toContain(ids.tenantB);
    expect(socketIoMock.__deliveries[0].room).not.toContain(ids.membershipB);
  });

  it("keeps two company memberships in the same tenant in separate rooms", async () => {
    prepareOwnedOrder({ tenantId: ids.tenantA, tenantMembershipId: ids.tenantMembershipSameTenant,
      membershipId: ids.membershipSameTenant, companyId: ids.companySameTenant, orderId: ids.orderB });

    await emitDriverOrderUpdate(ids.user, {
      orderId: ids.orderB,
      status: "in_transit",
      updatedAt: "2026-09-13T12:00:00.000Z",
    });

    expect(socketIoMock.__deliveries[0].room)
      .toBe(room(ids.tenantA, ids.membershipSameTenant, ids.companySameTenant));
    expect(socketIoMock.__deliveries[0].room)
      .not.toBe(room(ids.tenantA, ids.membershipA, ids.companyA));
  });

  it("suppresses delivery and persistence when authoritative order ownership is missing", async () => {
    database.order.findUnique.mockResolvedValue({
      id: ids.orderA,
      tenantId: null,
      ownerOrgId: null,
      assignedDriverId: ids.user,
    });

    await emitDriverNotification(ids.user, {
      type: "order",
      orderId: ids.orderA,
      title: "Order updated",
      body: "Current status: Assigned",
    });

    expect(socketIoMock.__deliveries).toHaveLength(0);
    expect(database.companyMembership.findUnique).not.toHaveBeenCalled();
    expect(createUserNotification).not.toHaveBeenCalled();
  });

  it.each([
    ["suspended membership", accessRecord({ tenantId: ids.tenantA,
      tenantMembershipId: ids.tenantMembershipA, membershipId: ids.membershipA,
      companyId: ids.companyA, status: "suspended" })],
    ["removed permission", accessRecord({ tenantId: ids.tenantA,
      tenantMembershipId: ids.tenantMembershipA, membershipId: ids.membershipA,
      companyId: ids.companyA, permissionCodes: [] })],
  ])("denies subsequent delivery and disconnects only the affected context after %s", async (_case, deniedRecord) => {
    prepareOwnedOrder({ tenantId: ids.tenantA, tenantMembershipId: ids.tenantMembershipA,
      membershipId: ids.membershipA, companyId: ids.companyA, orderId: ids.orderA });
    const disconnectA = jest.fn();
    const disconnectB = jest.fn();
    socketIoMock.__mockServer.sockets.sockets.set("a", trackedSocket({ data: { user: {
      id: ids.user, tenantId: ids.tenantA, companyId: ids.companyA,
      companyMembershipId: ids.membershipA,
    } }, disconnect: disconnectA }));
    socketIoMock.__mockServer.sockets.sockets.set("b", trackedSocket({ data: { user: {
      id: ids.user, tenantId: ids.tenantB, companyId: ids.companyB,
      companyMembershipId: ids.membershipB,
    } }, disconnect: disconnectB }));
    database.companyMembership.findFirst
      .mockResolvedValueOnce(accessRecord({ tenantId: ids.tenantA,
        tenantMembershipId: ids.tenantMembershipA, membershipId: ids.membershipA,
        companyId: ids.companyA }))
      .mockResolvedValueOnce(deniedRecord);

    await emitDriverOrderUpdate(ids.user, {
      orderId: ids.orderA,
      status: "assigned",
      updatedAt: "2026-09-13T12:00:00.000Z",
    });
    await emitDriverOrderUpdate(ids.user, {
      orderId: ids.orderA,
      status: "picked_up",
      updatedAt: "2026-09-13T12:01:00.000Z",
    });

    expect(socketIoMock.__deliveries).toHaveLength(1);
    expect(disconnectA).toHaveBeenCalledWith(true);
    expect(disconnectB).not.toHaveBeenCalled();
  });

  it("denies delivery and disconnects the affected context after membership deletion", async () => {
    prepareOwnedOrder({ tenantId: ids.tenantA, tenantMembershipId: ids.tenantMembershipA,
      membershipId: ids.membershipA, companyId: ids.companyA, orderId: ids.orderA });
    database.companyMembership.findUnique.mockResolvedValue(null);
    const disconnectA = jest.fn();
    const disconnectB = jest.fn();
    socketIoMock.__mockServer.sockets.sockets.set("a", trackedSocket({ data: { user: {
      id: ids.user, tenantId: ids.tenantA, companyId: ids.companyA,
      companyMembershipId: ids.membershipA,
    } }, disconnect: disconnectA }));
    socketIoMock.__mockServer.sockets.sockets.set("b", trackedSocket({ data: { user: {
      id: ids.user, tenantId: ids.tenantB, companyId: ids.companyB,
      companyMembershipId: ids.membershipB,
    } }, disconnect: disconnectB }));

    await emitDriverOrderUpdate(ids.user, {
      orderId: ids.orderA,
      status: "assigned",
      updatedAt: "2026-09-13T12:00:00.000Z",
    });

    expect(socketIoMock.__deliveries).toHaveLength(0);
    expect(disconnectA).toHaveBeenCalledWith(true);
    expect(disconnectB).not.toHaveBeenCalled();
    expect(database.companyMembership.findFirst).not.toHaveBeenCalled();
  });

  it("preserves authorized single-membership notification delivery and payload", async () => {
    prepareOwnedOrder({ tenantId: ids.tenantA, tenantMembershipId: ids.tenantMembershipA,
      membershipId: ids.membershipA, companyId: ids.companyA, orderId: ids.orderA });

    await emitDriverNotification(ids.user, {
      type: "order",
      orderId: ids.orderA,
      title: "Order updated",
      body: "Current status: Assigned",
    });

    expect(createUserNotification).toHaveBeenCalledTimes(1);
    expect(socketIoMock.__deliveries).toEqual([expect.objectContaining({
      room: room(ids.tenantA, ids.membershipA, ids.companyA),
      event: "driver:notification",
      payload: expect.objectContaining({ orderId: ids.orderA, type: "order" }),
    }), expect.objectContaining({
      room: room(ids.tenantA, ids.membershipA, ids.companyA),
      event: "driver:notifications:unread-count",
      payload: expect.objectContaining({ unreadCount: 1 }),
    })]);
  });

  it("emits unread count only to the verified selected context room", async () => {
    database.companyMembership.findFirst.mockResolvedValue(accessRecord({ tenantId:ids.tenantA,
      tenantMembershipId:ids.tenantMembershipA,membershipId:ids.membershipA,companyId:ids.companyA }));
    await emitDriverUnreadCount({
      id: ids.user,
      membershipId: ids.membershipA,
      companyMembershipId: ids.membershipA,
      companyId: ids.companyA,
      tenantId: ids.tenantA,
      tenantMembershipId: ids.tenantMembershipA,
    });
    expect(countUnreadUserNotifications).toHaveBeenCalledWith(expect.objectContaining({
      id: ids.user,
      companyMembershipId: ids.membershipA,
      tenantId: ids.tenantA,
    }));
    expect(socketIoMock.__deliveries).toEqual([expect.objectContaining({
      room: room(ids.tenantA, ids.membershipA, ids.companyA),
      event: "driver:notifications:unread-count",
      payload: expect.objectContaining({ unreadCount: 1 }),
    })]);
  });

  it("same membership separate roots deliver only to the live session and disconnect the revoked socket", async () => {
    prepareOwnedOrder({tenantId:ids.tenantA,tenantMembershipId:ids.tenantMembershipA,membershipId:ids.membershipA,companyId:ids.companyA,orderId:ids.orderA});
    const a=socketIoMock.__mockServer.sockets.sockets.get("a"), second=trackedSocket({data:{user:{...a.data.user,sid:ids.orderB}}});
    socketIoMock.__mockServer.sockets.sockets.set("second",second);
    (hasLiveAccessSession as jest.Mock).mockImplementation(async (claims:any)=>claims.sid!==ids.orderB);
    await emitDriverOrderUpdate(ids.user,{orderId:ids.orderA,status:"assigned",updatedAt:new Date().toISOString()});
    expect(socketIoMock.__deliveries).toHaveLength(1);expect(second.disconnect).toHaveBeenCalledWith(true);expect(a.disconnect).not.toHaveBeenCalled();
    expect(socketIoMock.__mockServer.to).not.toHaveBeenCalled();
  });
  it("expired connected token denies before database-session query, without protected delivery",async()=>{
    prepareOwnedOrder({tenantId:ids.tenantA,tenantMembershipId:ids.tenantMembershipA,membershipId:ids.membershipA,companyId:ids.companyA,orderId:ids.orderA});
    const a=socketIoMock.__mockServer.sockets.sockets.get("a");a.data.user.expiresAt=0;
    await emitDriverOrderUpdate(ids.user,{orderId:ids.orderA,status:"assigned",updatedAt:new Date().toISOString()});
    expect(hasLiveAccessSession).not.toHaveBeenCalled();expect(a.disconnect).toHaveBeenCalledWith(true);expect(socketIoMock.__deliveries).toHaveLength(0);
  });
  it("database-session failure suppresses delivery without a room fallback",async()=>{
    prepareOwnedOrder({tenantId:ids.tenantA,tenantMembershipId:ids.tenantMembershipA,membershipId:ids.membershipA,companyId:ids.companyA,orderId:ids.orderA});
    (hasLiveAccessSession as jest.Mock).mockRejectedValue(Error("synthetic read deadline"));
    await emitDriverOrderUpdate(ids.user,{orderId:ids.orderA,status:"assigned",updatedAt:new Date().toISOString()});expect(socketIoMock.__deliveries).toHaveLength(0);expect(socketIoMock.__mockServer.to).not.toHaveBeenCalled();
  });
});
