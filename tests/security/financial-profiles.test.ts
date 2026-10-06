import { FINANCIAL_PROFILES, financialProfilesSchema } from "../../src/modules/identity-access/application/financial-profiles";

describe("approved DOM-03 profile contract (offline)",()=>{
  it("contains exactly six immutable revision names",()=>{
    expect(Object.keys(FINANCIAL_PROFILES)).toEqual(["pricing-maker.v1","pricing-checker.v1","billing-operator.v1","price-exception-checker.v1","manual-invoice-issuer.v1","entity-configuration-reader.v1"]);
    expect(Object.isFrozen(FINANCIAL_PROFILES)).toBe(true);
  });
  it("never grants delegation, cash, generic order writes, entity settings writes or accounting",()=>{
    const keys=Object.values(FINANCIAL_PROFILES).flat();
    expect(keys.some(k=>/^(membership\.|platform\.|policy\.)/.test(k))).toBe(false);
    for(const key of ["shipment.view","shipment.update","finance.settleCash","finance.settings.manage","finance.journals.post","finance.treasury.execute"])
      expect(keys).not.toContain(key);
  });
  it("normalizes profile order without silently discarding duplicate requests",()=>{
    expect(financialProfilesSchema.parse(["pricing-maker.v1","billing-operator.v1"])).toEqual(["billing-operator.v1","pricing-maker.v1"]);
    expect(()=>financialProfilesSchema.parse(["pricing-maker.v1","pricing-maker.v1"])).toThrow();
  });
  it.each([[],["cash-settlement-checker.v1"],["driver-cash-collector.v1"],["finance-admin"],["entity-configuration-reader.v2"]].map(value=>[value]))("rejects unavailable/unapproved profiles %j",value=>{
    expect(()=>financialProfilesSchema.parse(value)).toThrow();
  });
});
