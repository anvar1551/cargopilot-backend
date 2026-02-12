import { Request, Response } from "express";
import { AppRole } from "@prisma/client";
import { listAddresses } from "./addressRepo";
import prisma from "../../config/prismaClient";
import { z } from "zod";

export async function list(req: Request, res: Response) {
  try {
    if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });

    const role = req.user.role as AppRole;

    if (role !== AppRole.manager && role !== AppRole.customer) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const take = req.query.take ? Number(req.query.take) : undefined;

    // ✅ manager can request any customer entity
    const queryCustomerEntityId =
      typeof req.query.customerEntityId === "string"
        ? req.query.customerEntityId
        : undefined;

    const customerEntityId =
      role === AppRole.manager
        ? queryCustomerEntityId // manager can pick
        : (req.user.customerEntityId ?? undefined); // self mode

    const rows = await listAddresses({
      customerEntityId,
      q,
      take,
    });

    return res.json(rows);
  } catch (e: any) {
    return res
      .status(500)
      .json({ error: e.message ?? "Failed to fetch addresses" });
  }
}

const addressCreateSchema = z.object({
  customerEntityId: z.string().uuid().optional().nullable(), // manager can set; customers usually omit
  country: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  neighborhood: z.string().optional().nullable(),
  street: z.string().optional().nullable(),
  addressLine1: z.string().optional().nullable(),
  addressLine2: z.string().optional().nullable(),
  building: z.string().optional().nullable(),
  apartment: z.string().optional().nullable(),
  floor: z.string().optional().nullable(),
  landmark: z.string().optional().nullable(),
  postalCode: z.string().optional().nullable(),
  addressType: z.enum(["RESIDENTIAL", "BUSINESS"]).optional().nullable(),
  isSaved: z.boolean().optional().default(true),
});

export async function create(req: Request, res: Response) {
  try {
    const dto = addressCreateSchema.parse(req.body);

    // ✅ determine owner
    const ownerCustomerEntityId =
      dto.customerEntityId ?? req.user?.customerEntityId ?? null;

    if (!ownerCustomerEntityId) {
      return res.status(400).json({
        error: "customerEntityId is required to create an address",
      });
    }

    const created = await prisma.address.create({
      data: {
        customerEntityId: ownerCustomerEntityId,
        country: dto.country ?? null,
        city: dto.city ?? null,
        neighborhood: dto.neighborhood ?? null,
        street: dto.street ?? null,
        addressLine1: dto.addressLine1 ?? null,
        addressLine2: dto.addressLine2 ?? null,
        building: dto.building ?? null,
        apartment: dto.apartment ?? null,
        floor: dto.floor ?? null,
        landmark: dto.landmark ?? null,
        postalCode: dto.postalCode ?? null,
        addressType: (dto.addressType as any) ?? null,
        isSaved: dto.isSaved ?? true,
      },
    });

    return res.status(201).json(created);
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? "Bad request" });
  }
}
