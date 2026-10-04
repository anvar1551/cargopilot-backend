import { createHash } from "node:crypto";
import { z } from "zod";

// Preparation only. Neither profileRevision nor any part of this input proves
// operator authority. No persistence or application startup dependency.
const code = z.string().trim().min(1).max(40)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/).transform(value => value.toUpperCase())
  .refine(value => value !== "CP_ROOT", "Reserved platform code");
const name = z.string().trim().min(1).max(160).regex(/^[^\u0000-\u001f\u007f]+$/);
const intentSchema = z.object({
  operationId: z.string().uuid().transform(value => value.toLowerCase()),
  tenant: z.object({ code, name }).strict(),
  company: z.object({ code, name }).strict(),
  administrator: z.object({
    email: z.string().trim().max(254).email().transform(value => value.toLowerCase()),
    name,
  }).strict(),
  profileRevision: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/),
  credentialCommitment: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().trim().min(1).max(500).regex(/^[^\u0000-\u001f\u007f]+$/),
}).strict();

export function normalizeTenantOnboardingIntent(input: unknown) {
  const intent = intentSchema.parse(input);
  // Zod projects into explicit schema key order, including strict nested fields.
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ version: 1, ...intent })).digest("hex");
  return { intent, fingerprint };
}
