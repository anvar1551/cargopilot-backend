import { executeRestrictedCash } from "./restricted-cash.service";
import { cashDenied } from "../../identity-access/application/cash-capability-eligibility";
/** Compatibility entrypoints retain context checks; old handoff target fields reject
 * rather than selecting a membership from a User identifier. */
function invoke(input:any,action:"collect"|"offer"|"settle") {
 const {actor,amount,expectedEventId,...intent}=input;
 if(amount!=null)return cashDenied("CALLER_MONETARY_AUTHORITY_FORBIDDEN",400);
 if(expectedEventId!=null)intent.expectedEventId=expectedEventId;
 return executeRestrictedCash(actor,action,intent);
}
export const collectOrderCash=(input:any)=>invoke(input,"collect");
export const handoffOrderCash=(input:any)=>invoke(input,"offer");
export const settleOrderCash=(input:any)=>invoke(input,"settle");
