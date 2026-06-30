import "dotenv/config";

import prisma from "../config/prismaClient";
import { seedSystemPermissions } from "../modules/identity-access/application/iam.service";

async function main() {
  await seedSystemPermissions();
  const permissionCount = await prisma.permission.count();
  const ownerRoleCount = await prisma.role.count({
    where: { isSystem: true, isOwnerRole: true },
  });
  console.log(
    `[seed-permissions] synced permissions=${permissionCount} ownerRoles=${ownerRoleCount}`,
  );
}

main()
  .catch((err) => {
    console.error("[seed-permissions] failed", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
