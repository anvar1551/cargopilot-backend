describe("opsMetrics SSE tracking", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  it("tracks reconnect spikes and active/disconnect counts", async () => {
    process.env.OPS_SSE_RECONNECT_WINDOW_MS = "2000";

    const ops = await import("../../src/modules/observability-core/application/opsMetrics");

    ops.recordSseConnected({ stream: "analytics", clientKey: "u1:ip" });
    ops.recordSseConnected({ stream: "analytics", clientKey: "u1:ip" });
    ops.recordSseDisconnected("analytics");

    const snapshot = ops.getOpsMetricsSnapshot();

    expect(snapshot.sse.analytics.totalConnects).toBeGreaterThanOrEqual(2);
    expect(snapshot.sse.analytics.totalDisconnects).toBeGreaterThanOrEqual(1);
    expect(snapshot.sse.analytics.reconnectSpikes).toBeGreaterThanOrEqual(1);
    expect(snapshot.sse.analytics.active).toBeGreaterThanOrEqual(1);
  });
});
