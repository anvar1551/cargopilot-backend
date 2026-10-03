import { getChartTemplate, type ChartTemplateAccount } from "./chart-template";
import { stableDraftJson } from "./draft-intent";
import { financeConflict } from "./finance.errors";

function reject(): never {
  throw financeConflict("Chart template source is inconsistent", "FINANCE_CHART_TEMPLATE_SOURCE_REJECTED");
}
/** A server template is configuration provenance, not independently approved accounting. */
export function requireChartTemplateSource(input: {templateCode:string;templateVersion:number;accounts:readonly ChartTemplateAccount[]}) {
  const expected = getChartTemplate(input.templateCode, input.templateVersion);
  if (!expected || stableDraftJson(input.accounts) !== stableDraftJson(expected)) reject();
  return expected;
}
export function assertChartInstallationSource(installation:any, accounts:any[], expected:readonly ChartTemplateAccount[],
  owner:{entityId:string;baseCurrency:string;templateCode:string;templateVersion:number}) {
  if (!installation || installation.legalEntityId !== owner.entityId || installation.templateCode !== owner.templateCode ||
    installation.templateVersion !== owner.templateVersion || installation.accountCount !== expected.length || accounts.length !== expected.length ||
    installation.metadataJson?.baseCurrency !== owner.baseCurrency) reject();
  const byId = new Map(accounts.map(account=>[account.id,account]));
  const normalize = (account:any) => ({code:account.code,name:account.name,type:account.type,
    parentCode:account.parentId ? byId.get(account.parentId)?.code ?? "__unbound__" : null,
    allowPosting:account.allowPosting,isControlAccount:account.isControlAccount,currency:account.currency??null,description:account.description??null});
  if (accounts.some(account=>account.legalEntityId !== owner.entityId || account.status !== "active" ||
      account.metadataJson?.templateCode !== owner.templateCode || account.metadataJson?.templateVersion !== owner.templateVersion)) reject();
  const actual=accounts.map(normalize).sort((a,b)=>a.code.localeCompare(b.code));
  const basis=expected.map(account=>({code:account.code,name:account.name,type:account.type,parentCode:account.parentCode??null,
    allowPosting:account.allowPosting,isControlAccount:account.isControlAccount??false,currency:null,description:account.description??null})).sort((a,b)=>a.code.localeCompare(b.code));
  if (stableDraftJson(actual)!==stableDraftJson(basis)) reject();
}
