import type { AppUser } from "../../../types/app-user";
import { listAllDrivers, requireDriverManagement } from "./driverRepo";
import { rejectGlobalWarehouseAssignments } from "../../warehouse-core/application/warehouseAccess";

export async function listDriversView(context: AppUser, query: unknown = {}) {
  return listAllDrivers(context, query);
}

export async function updateDriverProfileById(_driverId: string, body: unknown, context: AppUser | undefined) {
  await requireDriverManagement(context);
  rejectGlobalWarehouseAssignments((body ?? {}) as object);
  // All former fields mutate user-global operational classification/assignments.
  // Do not let one selected company alter a multi-company human's global business state.
  throw Object.assign(new Error("Membership-scoped driver configuration required"), { statusCode: 409 });
}
