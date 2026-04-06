import { Router } from "express";
import { AppRole } from "@prisma/client";
import { auth } from "../../middleware/auth";
import {
  create,
  confirmImport,
  downloadImportTemplate,
  exportCsv,
  list,
  previewImport,
  getOne,
  assignDriversBulk,
  assignTasksBulk,
  updateDriverStatus,
  updateStatusBulk,
  listDriverWorkload,
} from "./controller";

const router = Router();

router.post("/", auth([AppRole.customer, AppRole.manager]), create);
router.get("/import/template.csv", auth([AppRole.manager, AppRole.customer]), downloadImportTemplate);
router.post("/import/preview", auth([AppRole.manager, AppRole.customer]), previewImport);
router.post("/import/confirm", auth([AppRole.manager, AppRole.customer]), confirmImport);
router.get(
  "/",
  auth([AppRole.manager, AppRole.customer, AppRole.driver, AppRole.warehouse]),
  list,
);
router.get("/export.csv", auth([AppRole.manager]), exportCsv);
router.get(
  "/driver-workloads",
  auth([AppRole.manager, AppRole.warehouse]),
  listDriverWorkload,
);
router.post(
  "/assign-driver-bulk",
  auth([AppRole.manager, AppRole.warehouse]),
  assignDriversBulk,
);
router.post(
  "/tasks/assign-bulk",
  auth([AppRole.manager, AppRole.warehouse]),
  assignTasksBulk,
);
router.post(
  "/status-bulk",
  auth([AppRole.manager, AppRole.warehouse]),
  updateStatusBulk,
);
router.post("/driver-status", auth([AppRole.driver]), updateDriverStatus);
router.get(
  "/:id",
  auth([AppRole.manager, AppRole.warehouse, AppRole.customer, AppRole.driver]),
  getOne,
);

export default router;
