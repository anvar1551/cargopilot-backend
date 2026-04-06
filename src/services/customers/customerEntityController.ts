import { Request, Response } from "express";
import { CustomerType, AppRole } from "@prisma/client";
import { z } from "zod";

import {
  listCustomerEntities,
  createCustomerEntity,
  getCustomerEntityById,
} from "./customerEntityRepo";

// ---------------- LIST ----------------

export async function list(req: Request, res: Response) {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (
      req.user.role !== AppRole.manager &&
      req.user.role !== AppRole.customer
    ) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const q = typeof req.query.q === "string" ? req.query.q : undefined;

    const type =
      typeof req.query.type === "string"
        ? (req.query.type as CustomerType)
        : undefined;

    const page = req.query.page ? Number(req.query.page) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;

    const result = await listCustomerEntities({
      q,
      type,
      page,
      limit,
    });

    return res.json(result);
  } catch (err: any) {
    return res
      .status(500)
      .json({ error: err.message ?? "Failed to fetch customers" });
  }
}

// ---------------- CREATE ----------------

const createCustomerSchema = z
  .object({
    type: z.enum(["PERSON", "COMPANY"]),
    name: z.string().min(2),

    email: z.email().optional().nullable(),
    phone: z.string().optional().nullable(),
    altPhone1: z.string().optional().nullable(),
    altPhone2: z.string().optional().nullable(),

    companyName: z.string().optional().nullable(),
    taxId: z.string().optional().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.type === "COMPANY") {
      if (!v.companyName) {
        ctx.addIssue({
          code: "custom",
          path: ["companyName"],
          message: "Company name is required",
        });
      }
      if (!v.taxId) {
        ctx.addIssue({
          code: "custom",
          path: ["taxId"],
          message: "Tax ID is required",
        });
      }
    }
  });

export async function create(req: Request, res: Response) {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (req.user.role !== AppRole.manager) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const dto = createCustomerSchema.parse(req.body);

    const created = await createCustomerEntity(dto);

    return res.status(201).json(created);
  } catch (err: any) {
    return res
      .status(400)
      .json({ error: err.message ?? "Failed to create customer" });
  }
}

export async function getOne(req: Request, res: Response) {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (
      req.user.role !== AppRole.manager &&
      req.user.role !== AppRole.customer
    ) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const customer = await getCustomerEntityById(req.params.id);
    if (!customer) {
      return res.status(404).json({ error: "Not found" });
    }

    return res.json(customer);
  } catch (err: any) {
    return res
      .status(500)
      .json({ error: err.message ?? "Failed to fetch customer" });
  }
}
