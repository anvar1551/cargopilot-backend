// Process-wide limit with no waiting queue. Retain a permit until work actually
// settles; an HTTP disconnect/timeout must never free it or trigger a replay.
const capacity = 8;
let active = 0;
export async function withPaymentCallbackAdmission<T>(work: () => Promise<T>): Promise<T> {
  if (active >= capacity) throw Object.assign(Error("Payment callback capacity exhausted"),
    { statusCode: 503, code: "PAYMENT_CALLBACK_CAPACITY" });
  active++;
  try { return await work(); } finally { active--; }
}
