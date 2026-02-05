-- AlterTable
-- Cast the Invoice id column from text to UUID
ALTER TABLE "Invoice" ALTER COLUMN "id" TYPE UUID USING "id"::UUID;
