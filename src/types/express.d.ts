import "express";
import type { User as PrismaUser } from "@prisma/client";
import { CustomerEntityDelegate } from "./../../node_modules/.prisma/client/index.d";

type AppRole = PrismaUser["role"];

declare global {
  namespace Express {
    interface User {
      id: string;
      role: AppRole;
      customerEntityId?: string | null;
      email: string;
      name: string | null;
      warehouseId: string | null;
    }

    interface Request {
      user?: User;
    }
  }
}

export {};
