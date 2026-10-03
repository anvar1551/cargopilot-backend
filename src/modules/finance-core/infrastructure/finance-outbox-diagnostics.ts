/** Never accepts exception objects, names, URLs, SQL or credentials. */
export function logFinanceOutboxFailure(phase: "loop" | "crash") {
  const crashed = phase === "crash";
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    scope: "finance-outbox",
    level: "error",
    message: crashed ? "finance outbox worker crashed" : "finance outbox loop failed",
    error: { code: crashed ? "FINANCE_OUTBOX_WORKER_CRASHED" : "FINANCE_OUTBOX_LOOP_FAILED" },
  }));
}
