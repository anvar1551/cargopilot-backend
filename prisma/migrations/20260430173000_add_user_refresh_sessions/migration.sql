-- CreateTable
CREATE TABLE "UserRefreshSession" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "replacedBySessionId" UUID,
  "userAgent" TEXT,
  "ipAddress" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "UserRefreshSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserRefreshSession_tokenHash_key" ON "UserRefreshSession"("tokenHash");

-- CreateIndex
CREATE INDEX "UserRefreshSession_userId_createdAt_idx" ON "UserRefreshSession"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "UserRefreshSession_expiresAt_idx" ON "UserRefreshSession"("expiresAt");

-- CreateIndex
CREATE INDEX "UserRefreshSession_userId_revokedAt_expiresAt_idx" ON "UserRefreshSession"("userId", "revokedAt", "expiresAt");

-- AddForeignKey
ALTER TABLE "UserRefreshSession"
ADD CONSTRAINT "UserRefreshSession_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRefreshSession"
ADD CONSTRAINT "UserRefreshSession_replacedBySessionId_fkey"
FOREIGN KEY ("replacedBySessionId") REFERENCES "UserRefreshSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
