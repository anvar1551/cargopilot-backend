import {
  getChartTemplate,
  LOGISTICS_CHART_TEMPLATE_CODE,
  LOGISTICS_CHART_TEMPLATE_VERSION,
  LOGISTICS_STANDARD_CHART,
} from "../../src/modules/finance-core/domain/chart-template";

describe("logistics chart template", () => {
  it("has unique account codes and declares parents before children", () => {
    const seen = new Set<string>();
    for (const account of LOGISTICS_STANDARD_CHART) {
      expect(seen.has(account.code)).toBe(false);
      if (account.parentCode) expect(seen.has(account.parentCode)).toBe(true);
      seen.add(account.code);
    }
  });

  it("contains the operational control accounts needed by CargoPilot", () => {
    const byCode = new Map(LOGISTICS_STANDARD_CHART.map((account) => [account.code, account]));
    for (const code of ["1130", "1200", "1400", "2100", "2200", "2300", "2400"]) {
      expect(byCode.get(code)).toEqual(expect.objectContaining({ isControlAccount: true }));
    }
  });

  it("resolves only the supported version", () => {
    expect(getChartTemplate(LOGISTICS_CHART_TEMPLATE_CODE, LOGISTICS_CHART_TEMPLATE_VERSION)).toBe(
      LOGISTICS_STANDARD_CHART,
    );
    expect(getChartTemplate(LOGISTICS_CHART_TEMPLATE_CODE, 999)).toBeNull();
  });
});
