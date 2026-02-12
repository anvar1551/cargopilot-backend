import { Request, Response } from "express";
import { AppRole } from "@prisma/client";
import { listCustomerEntities } from "./customerEntityRepo";

export async function list(req: Request, res: Response) {
  try {
    if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });

    // decide who can see entities (usually manager + customer)
    const role = req.user.role as AppRole;
    if (role !== AppRole.manager && role !== AppRole.customer) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const take = req.query.take ? Number(req.query.take) : undefined;

    const rows = await listCustomerEntities({ q, take });
    return res.json(rows);
  } catch (e: any) {
    return res
      .status(500)
      .json({ error: e.message ?? "Failed to fetch customer entities" });
  }
}
