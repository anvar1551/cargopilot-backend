import { readRestrictedCash } from "./restricted-cash.service";
import { cashDenied } from "../../identity-access/application/cash-capability-eligibility";
export { collectOrderCash,handoffOrderCash,settleOrderCash } from "./custody.service";
export async function listCashQueueForActor(input:{actor:any;filters?:any}) {
 if(input.filters&&Object.keys(input.filters).some(k=>!["pageSize"].includes(k)&&input.filters[k]!==undefined))return cashDenied("CASH_CURSOR_CONTRACT_REQUIRED",400);
 return readRestrictedCash(input.actor,{...(input.filters?.pageSize?{limit:input.filters.pageSize}:{})});
}
export async function getCashQueueSummaryForActor(_input:{actor:any;filters?:any}):Promise<any>{return cashDenied("CASH_EXACT_SUMMARY_UNAVAILABLE",409);}
