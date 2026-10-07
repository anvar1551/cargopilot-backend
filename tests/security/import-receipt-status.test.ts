jest.mock("../../src/config/prismaClient", () => ({
  __esModule: true,
  default: { $transaction: jest.fn() },
}));
jest.mock("../../src/modules/orders-core/domain/company-authority", () => ({
  requireTenantBoundOrderCompanyAuthority: jest.fn(),
  hasCompanyScope: jest.fn(),
}));
jest.mock("../../src/modules/orders-core/domain/creation-references", () => ({
  validateCreationReferences: jest.fn(),
}));
import prisma from "../../src/config/prismaClient";
import {
  requireTenantBoundOrderCompanyAuthority,
  hasCompanyScope,
} from "../../src/modules/orders-core/domain/company-authority";
import { validateCreationReferences } from "../../src/modules/orders-core/domain/creation-references";
import { readImportReceiptStatus } from "../../src/modules/orders-core/read/import-receipt-status";
const operationId = "50000000-0000-4000-8000-000000000001";
const actor: any = {
  id: "creator",
  tenantId: "tenant-a",
  companyId: "company-a",
  companyMembershipId: "cm-a",
  tenantMembershipId: "tm-a",
};
const order = {
  id: "order-a",
  orderNumber: 17,
  tenantId: actor.tenantId,
  ownerOrgId: actor.companyId,
  customerId: actor.id,
  customerEntityId: null,
  senderAddressId: null,
  receiverAddressId: null,
};
let tx: any;
beforeEach(() => {
  jest.clearAllMocks();
  tx = {
    $executeRawUnsafe: jest.fn(),
    orderCreationIntent: {
      findFirst: jest
        .fn()
        .mockResolvedValue({
          id: "intent",
          operationId,
          rowCount: 2,
          normalizationVersion: 1,
          acceptedAt: new Date("2026-10-07T12:00:00Z"),
        }),
    },
    orderCreationReceipt: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { ordinal: 0, confirmedAt: new Date("2026-10-07T12:00:01Z"), order },
        ]),
    },
  };
  (prisma.$transaction as jest.Mock).mockImplementation((work) => work(tx));
  (requireTenantBoundOrderCompanyAuthority as jest.Mock).mockResolvedValue({});
  (hasCompanyScope as jest.Mock).mockReturnValue(true);
});
it("reads an original-context partial receipt with minimal ordered rows in a read-only snapshot", async () => {
  const result = await readImportReceiptStatus(actor, operationId);
  expect(tx.$executeRawUnsafe).toHaveBeenNthCalledWith(
    1,
    "SET TRANSACTION READ ONLY",
  );
  expect(tx.orderCreationIntent.findFirst.mock.calls[0][0].where).toEqual({
    operationId,
    kind: "import",
    tenantId: actor.tenantId,
    companyId: actor.companyId,
    userId: actor.id,
    companyMembershipId: actor.companyMembershipId,
    tenantMembershipId: actor.tenantMembershipId,
  });
  expect(tx.orderCreationReceipt.findMany.mock.calls[0][0].take).toBe(101);
  expect(result.rows).toEqual([
    {
      ordinal: 0,
      state: "committed",
      confirmedAt: "2026-10-07T12:00:01.000Z",
      order: { id: "order-a", orderNumber: 17 },
    },
    { ordinal: 1, state: "pending" },
  ]);
  expect(result.complete).toBe(false);
  expect(result.downstreamCompletion).toBe("not_assessed");
  expect(validateCreationReferences).toHaveBeenCalledWith(
    tx,
    actor,
    order,
    false,
  );
});
it("complete receipts still do not assert downstream success", async () => {
  tx.orderCreationReceipt.findMany.mockResolvedValue(
    [0, 1].map((ordinal) => ({ ordinal, confirmedAt: new Date(), order })),
  );
  expect((await readImportReceiptStatus(actor, operationId)).complete).toBe(
    true,
  );
});
it("missing/foreign creator or selected context is not found", async () => {
  tx.orderCreationIntent.findFirst.mockResolvedValue(null);
  await expect(
    readImportReceiptStatus(actor, operationId),
  ).rejects.toMatchObject({ statusCode: 404 });
  expect(tx.orderCreationReceipt.findMany).not.toHaveBeenCalled();
});
it("fresh missing or revoked context fails before reading receipts", async () => {
  (requireTenantBoundOrderCompanyAuthority as jest.Mock).mockRejectedValue(
    new Error("revoked"),
  );
  await expect(readImportReceiptStatus(actor, operationId)).rejects.toThrow(
    "revoked",
  );
  expect(tx.orderCreationIntent.findFirst).not.toHaveBeenCalled();
});
it("missing company creation scope fails closed", async () => {
  (hasCompanyScope as jest.Mock).mockReturnValue(false);
  await expect(
    readImportReceiptStatus(actor, operationId),
  ).rejects.toMatchObject({ statusCode: 403 });
  expect(tx.orderCreationIntent.findFirst).not.toHaveBeenCalled();
});
it.each([
  { tenantId: "foreign" },
  { ownerOrgId: "foreign" },
  { customerId: "another" },
])(
  "inconsistent confirmed ownership %j denies the entire projection",
  async (change) => {
    tx.orderCreationReceipt.findMany.mockResolvedValue([
      { ordinal: 0, confirmedAt: new Date(), order: { ...order, ...change } },
    ]);
    await expect(
      readImportReceiptStatus(actor, operationId),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(validateCreationReferences).not.toHaveBeenCalled();
  },
);
it("revoked customer/object access denies existing receipts", async () => {
  (validateCreationReferences as jest.Mock).mockRejectedValueOnce(
    new Error("customer denied"),
  );
  await expect(readImportReceiptStatus(actor, operationId)).rejects.toThrow(
    "customer denied",
  );
});
it.each([0, 101])(
  "invalid persisted row count %s fails closed",
  async (rowCount) => {
    tx.orderCreationIntent.findFirst.mockResolvedValue({
      rowCount,
      normalizationVersion: 1,
    });
    await expect(
      readImportReceiptStatus(actor, operationId),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(tx.orderCreationReceipt.findMany).not.toHaveBeenCalled();
  },
);
it("invalid UUID fails before opening the transaction", async () => {
  await expect(readImportReceiptStatus(actor, "invalid")).rejects.toThrow();
  expect(prisma.$transaction).not.toHaveBeenCalled();
});
