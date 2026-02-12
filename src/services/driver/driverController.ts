import { Request, Response } from "express";
import { listAllDrivers } from "./driverRepo";

export const listDrivers = async (req: Request, res: Response) => {
  try {
    const drivers = await listAllDrivers();
    res.json(drivers);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch drivers" });
  }
};
