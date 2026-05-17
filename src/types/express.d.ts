import type { ActorRole } from "../modules/identity-access";

declare global {
  namespace Express {
    interface User {
      id: string;
      role: ActorRole;
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
