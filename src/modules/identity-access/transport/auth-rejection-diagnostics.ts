import { performance } from "perf_hooks";

const rejectionCodes = [
  "LOGIN_CREDENTIALS_REJECTED", "LOGIN_SELECTION_REJECTED", "LOGIN_UNAVAILABLE",
  "REFRESH_REJECTED", "REFRESH_UNAVAILABLE", "AUTH_ADMISSION_LIMITED", "AUTH_ADMISSION_UNAVAILABLE",
] as const;
export type AuthRejectionCode = typeof rejectionCodes[number];
export type AuthRejectionDiagnostic = Readonly<{
  event: "authentication_rejected";
  code: AuthRejectionCode;
  suppressed: number;
}>;

/** No request/exception/identity argument; fixed memory and output budgets. */
export function createAuthRejectionReporter(now: () => number = () => performance.now()) {
  const buckets = new Map<AuthRejectionCode, { emitted: number; suppressed: number }>(
    rejectionCodes.map(code => [code, { emitted: 0, suppressed: 0 }]),
  );
  let windowStarted = now();
  let emitted = 0;
  return (code: AuthRejectionCode, sink: (diagnostic: AuthRejectionDiagnostic) => void) => {
    const bucket = buckets.get(code);
    if (!bucket) return; // Runtime callers cannot expand labels or log arbitrary strings.
    const time = now();
    if (Number.isFinite(time) && time - windowStarted >= 60_000) {
      windowStarted = time;
      emitted = 0;
      for (const value of buckets.values()) value.emitted = 0;
    }
    if (emitted >= 12 || bucket.emitted >= 2) {
      bucket.suppressed = Math.min(1_000_000, bucket.suppressed + 1);
      return;
    }
    emitted += 1;
    bucket.emitted += 1;
    const suppressed = bucket.suppressed;
    bucket.suppressed = 0;
    try { sink(Object.freeze({ event: "authentication_rejected", code, suppressed })); }
    catch { /* Telemetry failure cannot change the authorization decision. */ }
  };
}

// Shared across route registrations in one process, never keyed by attacker input.
export const recordAuthRejection = createAuthRejectionReporter();
