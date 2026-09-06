/** Input containment, before validators can strip unknown legacy fields. */
export function authorityError(message: string, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const financialFields = new Set([
  "paid", "ispaid", "status", "paidstatus", "paymentstatus", "paymentstate",
  "codpaidstatus", "servicechargepaidstatus", "settled", "issettled",
  "settlementstatus", "postingstatus", "paidat", "paidamount", "amountpaid",
  "amount", "amountminor", "servicecharge", "total", "totalamount",
]);
const masterReferences = new Set(["customerentityid", "senderaddressid", "receiveraddressid", "addressid"]);

export function assertCreationInputAuthority(raw: unknown) {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: raw, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (!value || typeof value !== "object") continue;
    if (++visited > 10000 || depth > 24) throw authorityError("Creation input exceeds structural limits");
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.replace(/[^a-zA-Z]/g, "").toLowerCase();
      if (financialFields.has(normalized)) {
        throw authorityError("Client financial amounts and paid/status fields are not accepted");
      }
      if ((masterReferences.has(normalized) && child != null && child !== "") ||
          ((normalized === "savepickuptoaddressbook" || normalized === "savedropofftoaddressbook") && child !== false && child != null)) {
        throw authorityError("Customer/address ownership cannot be established; use address snapshots", 403);
      }
      pending.push({ value: child, depth: depth + 1 });
    }
  }
}
