CREATE TABLE "OperationalSlaPolicy" (
  "id" UUID NOT NULL,
  "singletonKey" TEXT NOT NULL DEFAULT 'global',
  "staleHours" INTEGER NOT NULL DEFAULT 48,
  "dueSoonHours" INTEGER NOT NULL DEFAULT 24,
  "overdueGraceHours" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "OperationalSlaPolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OperationalSlaPolicy_singletonKey_key" ON "OperationalSlaPolicy"("singletonKey");