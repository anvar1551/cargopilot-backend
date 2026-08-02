"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mockSupportTicketCount = jest.fn();
const mockUserFindMany = jest.fn();
jest.mock("../../src/config/prismaClient", () => ({
    __esModule: true,
    default: {
        supportTicket: {
            count: mockSupportTicketCount,
        },
        user: {
            findMany: mockUserFindMany,
        },
    },
}));
jest.mock("../../src/modules/support-core/infrastructure/supportCache", () => ({
    getOrComputeSupportCached: jest.fn(async (args) => ({
        payload: await args.compute(),
        cacheHit: false,
    })),
    invalidateSupportCache: jest.fn(async () => undefined),
}));
jest.mock("../../src/modules/support-core/realtime/supportRealtime", () => ({
    publishSupportRefresh: jest.fn(async () => undefined),
}));
jest.mock("../../src/modules/analytics-core/infrastructure/analyticsOutbox", () => ({
    enqueueCargoPilotDomainEventTx: jest.fn(async () => undefined),
}));
jest.mock("../../src/modules/notifications-core/application/notificationService", () => ({
    createUserNotification: jest.fn(async () => undefined),
}));
const supportService_1 = require("../../src/modules/support-core/application/supportService");
const actor = {
    id: "0198c72f-1800-7000-8000-000000000001",
    companyId: "0198c72f-1800-7000-8000-000000000002",
    permissionCodes: ["support.view", "support.assign"],
};
describe("support service RBAC projections", () => {
    beforeEach(() => {
        mockSupportTicketCount.mockReset();
        mockUserFindMany.mockReset();
    });
    it("applies the actor scope to every support summary counter", async () => {
        mockSupportTicketCount
            .mockResolvedValueOnce(4)
            .mockResolvedValueOnce(1)
            .mockResolvedValueOnce(2)
            .mockResolvedValueOnce(1)
            .mockResolvedValueOnce(3)
            .mockResolvedValueOnce(2);
        const summary = await (0, supportService_1.getSupportSummary)({
            actor,
            scopeWhere: { ownerOrgId: actor.companyId },
        });
        expect(summary).toEqual({
            open: 4,
            escalated: 1,
            waitingCustomer: 2,
            waitingDriver: 1,
            waiting: 3,
            resolvedToday: 3,
            slaRisk: 2,
        });
        expect(mockSupportTicketCount).toHaveBeenCalledTimes(6);
        for (const [call] of mockSupportTicketCount.mock.calls) {
            expect(JSON.stringify(call.where)).toContain(actor.companyId);
            expect(JSON.stringify(call.where)).toContain("ownerOrgId");
        }
    });
    it("lists only active support operators in the actor company", async () => {
        mockUserFindMany.mockResolvedValue([
            { id: "operator-1", name: "Support Operator", email: "support@example.com" },
        ]);
        const result = await (0, supportService_1.listSupportAssignees)(actor);
        expect(result).toHaveLength(1);
        expect(mockUserFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                memberships: {
                    some: expect.objectContaining({
                        companyId: actor.companyId,
                        status: "active",
                        roles: {
                            some: {
                                role: {
                                    rolePermissions: {
                                        some: { permission: { key: "support.update" } },
                                    },
                                },
                            },
                        },
                    }),
                },
            },
        }));
    });
    it("returns no assignees without an active company context", async () => {
        await expect((0, supportService_1.listSupportAssignees)({ id: actor.id })).resolves.toEqual([]);
        expect(mockUserFindMany).not.toHaveBeenCalled();
    });
});
