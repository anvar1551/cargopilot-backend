import type { Request, Response } from "express";
import { getOpsMetricsSnapshot } from "../observability/opsMetrics";

export async function getManagerOpsMetricsController(_req: Request, res: Response) {
  try {
    const snapshot = getOpsMetricsSnapshot();
    return res.json(snapshot);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Failed to load ops metrics" });
  }
}

