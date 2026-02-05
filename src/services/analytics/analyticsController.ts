import { Request, Response } from "express";
import * as analyticsRepo from "./analyticsRepo";

export async function getManagerOverview(req: Request, res: Response) {
  try {
    const data = await analyticsRepo.getManagerOverview();
    res.json(data);
  } catch (error) {
    console.error("Error fetching manager overview:", error);
    res.status(500).json({ error: "Failed to fetch manager overview" });
  }
}
