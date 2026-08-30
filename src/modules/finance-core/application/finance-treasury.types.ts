import type { prepareBankStatement, preparePaymentRun } from "../domain/treasury";

export type ReturnTypeOfPreparePaymentRun = ReturnType<typeof preparePaymentRun>;
export type ReturnTypeOfPrepareBankStatement = ReturnType<typeof prepareBankStatement>;
