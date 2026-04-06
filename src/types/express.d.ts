import "express";
import type { AppRole } from "@prisma/client";

declare global {
  namespace Express {
    interface User {
      id: string;
      role: AppRole;
      customerEntityId?: string | null;
      email: string;
      name: string;
      warehouseId: string | null;
    }

    interface Request {
      user?: User;
    }
  }
}

export {};
