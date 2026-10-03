-- No historical rewrite; enum extension precedes new accepted-session writers.
ALTER TYPE "CredentialSecurityAction" ADD VALUE 'LOGIN_ACCEPTED';
ALTER TYPE "CredentialSecurityAction" ADD VALUE 'LOGOUT_ACCEPTED';
