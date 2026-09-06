jest.mock("../../src/modules/identity-access", () => ({ authorize: jest.fn(), buildOrderScopeWhere: jest.fn(async () => ({ ownerOrgId: "company-a" })) }));
jest.mock("../../src/modules/orders-core/repo", () => ({ countOrdersForExport: jest.fn(async () => 1), listOrdersForExport: jest.fn() }));
import { Prisma } from "@prisma/client";
import { csvEscape } from "../../src/utils/csv";
import { authorize } from "../../src/modules/identity-access";
import { countOrdersForExport, listOrdersForExport } from "../../src/modules/orders-core/repo";
import { exportOrdersCsvForActor } from "../../src/modules/orders-core/read/queries";

it.each(["=1+1", "+SUM(A1)", "-1+2", "@SUM(A1)", "\ttext", "\rtext", "\ntext", "   =1", "\u0000\u001f=1", "\ufeff@x", "\u200b\t+1", "\u00a0-1", "\u202e=1", " +4912345"])("neutralizes untrusted text prefix %p", (value) => {
  expect(csvEscape(value)).toBe(`"'${value.replace(/"/g, '""')}"`);
});
it.each([0, -12, 12.5, -123n, new Prisma.Decimal("-12.50")])("preserves legitimate typed numeric value %p", (value) => expect(csvEscape(value)).toBe(`"${value}"`));
it("preserves CSV quoting and ordinary text/date/empty values", () => {
  expect(csvEscape('ordinary, "quoted" text')).toBe('"ordinary, ""quoted"" text"');
  expect(csvEscape('  normal')).toBe('"  normal"'); expect(csvEscape(null)).toBe('""');
  expect(csvEscape(new Date("2026-09-06T12:00:00Z"))).toBe('"2026-09-06T12:00:00.000Z"');
  expect(csvEscape('-12.50')).toBe('"\'-12.50"');
});
it("applies neutralization to the real authorized order export without altering typed amounts", async () => {
  (listOrdersForExport as jest.Mock).mockResolvedValue([{ id: "order-a", customer: { name: " =HYPERLINK(\"bad\")" }, receiverPhone: "+491234", codAmount: -12, invoice: { amount: new Prisma.Decimal("-1.25") } }]);
  const result = await exportOrdersCsvForActor({ actor: { id: "user-a" } as any, query: {} });
  expect(result.csv).toContain('"\' =HYPERLINK(""bad"")"'); expect(result.csv).toContain('"\'+491234"');
  expect(result.csv).toContain('"-12"'); expect(result.csv).toContain('"-1.25"');
  expect(listOrdersForExport).toHaveBeenCalledWith(expect.anything(), { ownerOrgId: "company-a" });
});
it("does not query/export business data after authorization rejection", async () => {
  jest.clearAllMocks(); (authorize as jest.Mock).mockRejectedValueOnce(new Error("Forbidden"));
  await expect(exportOrdersCsvForActor({ actor: {} as any, query: {} })).rejects.toThrow("Forbidden");
  expect(countOrdersForExport).not.toHaveBeenCalled(); expect(listOrdersForExport).not.toHaveBeenCalled();
});
