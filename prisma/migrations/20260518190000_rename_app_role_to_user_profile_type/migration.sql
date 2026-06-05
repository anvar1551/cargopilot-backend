-- Rename legacy role enum to neutral ERP naming.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AppRole')
     AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'UserProfileType') THEN
    ALTER TYPE "AppRole" RENAME TO "UserProfileType";
  END IF;
END $$;