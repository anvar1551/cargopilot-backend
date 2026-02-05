import "express";
import type { User as PrismaUser } from "@prisma/client";

type AppRole = PrismaUser["role"];

declare global {
  namespace Express {
    interface User {
      id: string;
      role: AppRole;
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
