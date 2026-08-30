export const LOGISTICS_CHART_TEMPLATE_CODE = "logistics_standard";
export const LOGISTICS_CHART_TEMPLATE_VERSION = 1;

export type ChartTemplateAccount = {
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
  parentCode?: string;
  allowPosting: boolean;
  isControlAccount?: boolean;
  description: string;
};

export const LOGISTICS_STANDARD_CHART: readonly ChartTemplateAccount[] = [
  { code: "1000", name: "Assets", type: "asset", allowPosting: false, description: "Asset account group" },
  { code: "1100", name: "Cash and cash equivalents", type: "asset", parentCode: "1000", allowPosting: false, description: "Cash account group" },
  { code: "1110", name: "Cash on hand", type: "asset", parentCode: "1100", allowPosting: true, description: "Physical operational cash" },
  { code: "1120", name: "Bank accounts", type: "asset", parentCode: "1100", allowPosting: true, description: "Company bank balances" },
  { code: "1130", name: "Payment provider clearing", type: "asset", parentCode: "1100", allowPosting: true, isControlAccount: true, description: "Stripe, Click, Payme, and Uzum clearing" },
  { code: "1200", name: "Accounts receivable", type: "asset", parentCode: "1000", allowPosting: true, isControlAccount: true, description: "Customer subledger control" },
  { code: "1300", name: "Other current assets", type: "asset", parentCode: "1000", allowPosting: true, description: "Other current assets" },
  { code: "1400", name: "Driver cash receivable", type: "asset", parentCode: "1000", allowPosting: true, isControlAccount: true, description: "Cash held by drivers" },
  { code: "1500", name: "Prepaid expenses", type: "asset", parentCode: "1000", allowPosting: true, description: "Prepayments and deposits" },
  { code: "2000", name: "Liabilities", type: "liability", allowPosting: false, description: "Liability account group" },
  { code: "2100", name: "Accounts payable", type: "liability", parentCode: "2000", allowPosting: true, isControlAccount: true, description: "Supplier and carrier subledger control" },
  { code: "2200", name: "Customer COD payable", type: "liability", parentCode: "2000", allowPosting: true, isControlAccount: true, description: "COD collected on behalf of customers" },
  { code: "2300", name: "Taxes payable", type: "liability", parentCode: "2000", allowPosting: true, isControlAccount: true, description: "Tax control account" },
  { code: "2400", name: "Carrier cost accruals", type: "liability", parentCode: "2000", allowPosting: true, isControlAccount: true, description: "Accrued carrier costs not yet billed" },
  { code: "3000", name: "Equity", type: "equity", allowPosting: false, description: "Equity account group" },
  { code: "3100", name: "Retained earnings", type: "equity", parentCode: "3000", allowPosting: true, description: "Accumulated retained earnings" },
  { code: "4000", name: "Revenue", type: "revenue", allowPosting: false, description: "Revenue account group" },
  { code: "4100", name: "Delivery service revenue", type: "revenue", parentCode: "4000", allowPosting: true, description: "Core shipment service revenue" },
  { code: "4200", name: "Surcharge revenue", type: "revenue", parentCode: "4000", allowPosting: true, description: "Fuel, remote-area, and handling surcharges" },
  { code: "4300", name: "Insurance revenue", type: "revenue", parentCode: "4000", allowPosting: true, description: "Shipment insurance revenue" },
  { code: "4400", name: "Other operating revenue", type: "revenue", parentCode: "4000", allowPosting: true, description: "Other operating revenue" },
  { code: "5000", name: "Cost of services", type: "expense", allowPosting: false, description: "Direct service cost group" },
  { code: "5100", name: "Carrier expense", type: "expense", parentCode: "5000", allowPosting: true, description: "External carrier expense" },
  { code: "5200", name: "Last-mile delivery expense", type: "expense", parentCode: "5000", allowPosting: true, description: "Last-mile operating costs" },
  { code: "5300", name: "Warehouse handling expense", type: "expense", parentCode: "5000", allowPosting: true, description: "Warehouse and sorting costs" },
  { code: "5400", name: "Payment provider fees", type: "expense", parentCode: "5000", allowPosting: true, description: "Payment provider processing fees" },
  { code: "5500", name: "Refund and claims expense", type: "expense", parentCode: "5000", allowPosting: true, description: "Refunds, claims, and service recovery" },
  { code: "6000", name: "Operating expenses", type: "expense", allowPosting: false, description: "Operating expense group" },
  { code: "6100", name: "Payroll expense", type: "expense", parentCode: "6000", allowPosting: true, description: "Payroll and benefits" },
  { code: "6200", name: "Rent and utilities", type: "expense", parentCode: "6000", allowPosting: true, description: "Facilities expense" },
  { code: "6300", name: "Software and integrations", type: "expense", parentCode: "6000", allowPosting: true, description: "Software, API, and infrastructure expense" },
  { code: "6400", name: "General administration", type: "expense", parentCode: "6000", allowPosting: true, description: "General administrative expense" },
  { code: "7100", name: "Foreign exchange gain", type: "revenue", allowPosting: true, description: "Realized and unrealized FX gains" },
  { code: "7200", name: "Foreign exchange loss", type: "expense", allowPosting: true, description: "Realized and unrealized FX losses" },
] as const;

export function getChartTemplate(code: string, version: number) {
  if (code === LOGISTICS_CHART_TEMPLATE_CODE && version === LOGISTICS_CHART_TEMPLATE_VERSION) {
    return LOGISTICS_STANDARD_CHART;
  }
  return null;
}
