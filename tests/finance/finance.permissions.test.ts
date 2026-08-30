import { SYSTEM_PERMISSIONS } from "../../src/modules/identity-access/permission-registry";

describe("finance permission registry", () => {
  it("defines the complete phase-one finance permission surface", () => {
    const keys = new Set(SYSTEM_PERMISSIONS.map((permission) => permission.key));
    for (const key of [
      "finance.settings.read",
      "finance.settings.manage",
      "finance.accounts.read",
      "finance.accounts.manage",
      "finance.postingRules.read",
      "finance.postingRules.manage",
      "finance.periods.read",
      "finance.periods.manage",
      "finance.periods.close",
      "finance.journals.read",
      "finance.journals.create",
      "finance.journals.post",
      "finance.journals.reverse",
      "finance.reports.read",
      "finance.exceptions.read",
      "finance.exceptions.manage",
      "finance.invoices.read",
      "finance.invoices.issue",
      "finance.receivables.read",
      "finance.settlements.read",
      "finance.settlements.manage",
      "finance.settlements.approve",
      "finance.payables.read",
      "finance.payables.manage",
      "finance.payables.approve",
      "finance.treasury.read",
      "finance.treasury.manage",
      "finance.treasury.approve",
      "finance.treasury.execute",
      "finance.bankReconciliation.read",
      "finance.bankReconciliation.manage",
      "finance.bankReconciliation.approve",
    ]) {
      expect(keys.has(key)).toBe(true);
    }
  });
});
