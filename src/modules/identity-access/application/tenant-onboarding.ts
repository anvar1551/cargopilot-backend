import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { normalizeTenantOnboardingIntent } from "./tenant-onboarding-intent";
import { DRIVER_DELEGATION_REVISION } from "./driver-profiles";

export const ONBOARDING_OPERATOR = "cargopilot-bootstrap-owner";
export const ONBOARDING_PROFILE = "initial-operational-admin.v1";
export const ONBOARDING_PROFILE_V2 = "initial-operational-admin.v2";
export const ONBOARDING_PERMISSIONS = Object.freeze([
  "organizations.read", "customers.read", "customers.write",
  "shipment.view", "shipment.create", "notifications.read",
] as const);
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const hex = z.string().regex(/^[a-f0-9]{64}$/);

// Controlled offline preparation only. The hash is a credential: do not print,
// log, publish or put it in an audit/receipt. Persist only in the new User row.
export async function prepareOnboardingCredential(password: string) {
  if (typeof password !== "string" || password.trim().length < 12 ||
    Buffer.byteLength(password, "utf8") > 72 || /[\u0000-\u001f\u007f]/.test(password)) return denied("ONBOARDING_CREDENTIAL_INVALID");
  const initialCredentialHash = await bcrypt.hash(password, 12);
  return { initialCredentialHash, credentialCommitment: digest(initialCredentialHash) };
}
const registrySchema = z.object({ version: z.literal(1), enabled: z.literal(true),
  operatorId: z.literal(ONBOARDING_OPERATOR), profileRevision: z.enum([ONBOARDING_PROFILE, ONBOARDING_PROFILE_V2, DRIVER_DELEGATION_REVISION, "warehouse-provisioning.v1"]),
  revoked: z.literal(false), keyFingerprint: hex,
  publicKeyPem: z.string().max(4096),
}).strict();
const permitSchema = z.object({ version: z.literal(1), operatorId: z.literal(ONBOARDING_OPERATOR),
  keyFingerprint: hex, operationId: z.string().uuid(), intentFingerprint: hex,
  profileRevision: z.enum([ONBOARDING_PROFILE, ONBOARDING_PROFILE_V2, DRIVER_DELEGATION_REVISION, "warehouse-provisioning.v1"]), issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

// This is also the exact signing representation. No private key is loaded here.
export function canonicalOnboardingPermit(input: unknown) {
  return JSON.stringify(permitSchema.parse(input));
}

function denied(code: string): never {
  throw Object.assign(new Error(code), { code });
}

export function authenticateControlledOperatorPermit(input: unknown, signature: string, operationId: string,
  intentFingerprint: string, profileRevision: string) {
  try {
    // Deployment-owned path ONLY. Neither request nor tenant roles can select keys.
    const path = process.env.CARGOPILOT_ONBOARDING_REGISTRY_PATH;
    if (!path || !isAbsolute(path)) return denied("ONBOARDING_NOT_CONFIGURED");
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) return denied("ONBOARDING_REGISTRY_INVALID");
    const registry = registrySchema.parse(JSON.parse(readFileSync(path, "utf8")));
    const key = createPublicKey(registry.publicKeyPem);
    const fingerprint = digest(key.export({ type: "spki", format: "der" }));
    if (key.asymmetricKeyType !== "ed25519" || fingerprint !== registry.keyFingerprint) return denied("ONBOARDING_REGISTRY_INVALID");
    const permit = permitSchema.parse(input);
    const now = Date.now(), issued = Date.parse(permit.issuedAt), expires = Date.parse(permit.expiresAt);
    if (registry.profileRevision !== profileRevision || permit.profileRevision !== profileRevision ||
      permit.keyFingerprint !== fingerprint || permit.operationId !== operationId ||
      permit.intentFingerprint !== intentFingerprint || issued > now + 30000 ||
      expires <= now || expires <= issued || expires - issued > 300000) return denied("ONBOARDING_PERMIT_INVALID");
    if (typeof signature !== "string" || signature.length !== 88) return denied("ONBOARDING_PERMIT_INVALID");
    const bytes = Buffer.from(signature, "base64");
    if (bytes.length !== 64 || bytes.toString("base64") !== signature ||
      !verify(null, Buffer.from(canonicalOnboardingPermit(permit)), key, bytes)) return denied("ONBOARDING_PERMIT_INVALID");
    return { operatorId: permit.operatorId, keyFingerprint: fingerprint, profileRevision: permit.profileRevision };
  } catch {
    // Do not expose registry paths, payloads, parser errors or credentials.
    return denied("ONBOARDING_AUTHORITY_REJECTED");
  }
}

type Result = { tenantId: string; companyId: string; userId: string;
  tenantMembershipId: string; companyMembershipId: string; roleId: string };
type Receipt = Result & { operatorId: string; keyFingerprint: string;
  intentFingerprint: string; profileRevision: string };

/** Internal operator mechanism only: no HTTP/queue entrypoint or default registry.
 * db is the server-owned database dependency, never a request-supplied endpoint.
 * The initial bcrypt hash is a credential, carried separately from signed intent.
 * Its commitment is signed; substitution is rejected. Confirmed retries cannot
 * change it and may omit the original hash. No plaintext credential reaches db.
 */
export async function onboardTenant(db: PrismaClient, args: {
  intent: unknown; permit: unknown; signature: string; initialCredentialHash?: string;
}): Promise<Result> {
  let prepared: ReturnType<typeof normalizeTenantOnboardingIntent>;
  try { prepared = normalizeTenantOnboardingIntent(args.intent); }
  catch { return denied("ONBOARDING_INTENT_INVALID"); }
  const { intent, fingerprint } = prepared;
  if (![ONBOARDING_PROFILE, ONBOARDING_PROFILE_V2].includes(intent.profileRevision)) return denied("ONBOARDING_PROFILE_REJECTED");
  const authenticatePermit = (permit: unknown, signature: string, operationId: string, fingerprint: string) =>
    authenticateControlledOperatorPermit(permit, signature, operationId, fingerprint, intent.profileRevision);
  const authority = authenticatePermit(args.permit, args.signature, intent.operationId, fingerprint);
  const grantKeys = intent.profileRevision === ONBOARDING_PROFILE_V2
    ? [...ONBOARDING_PERMISSIONS, "membership.invite", "membership.delegateOperational"] : [...ONBOARDING_PERMISSIONS];
  const hash = args.initialCredentialHash;
  if (hash !== undefined && (typeof hash !== "string" ||
    !/^\$2[ab]\$12\$[./A-Za-z0-9]{53}$/.test(hash) || digest(hash) !== intent.credentialCommitment)) return denied("ONBOARDING_CREDENTIAL_CONFLICT");
  try {
    return await db.$transaction(async tx => {
      // Transaction-scoped, common identity lock. UUID is not authorization.
      await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${"tenant-onboarding:" + intent.operationId}, 0))) AS lock`;
      const current = authenticatePermit(args.permit, args.signature, intent.operationId, fingerprint);
      if (current.keyFingerprint !== authority.keyFingerprint) return denied("ONBOARDING_AUTHORITY_CHANGED");
      const rows = await tx.$queryRaw<Receipt[]>`SELECT "tenantId", "companyId", "userId", "tenantMembershipId", "companyMembershipId", "roleId", "operatorId", "keyFingerprint", "intentFingerprint", "profileRevision" FROM "TenantOnboardingReceipt" WHERE "operationId"=${intent.operationId}::uuid`;
      const previous = rows[0];
      if (previous) {
        if (previous.operatorId !== current.operatorId || previous.keyFingerprint !== current.keyFingerprint ||
          previous.intentFingerprint !== fingerprint || previous.profileRevision !== current.profileRevision) return denied("ONBOARDING_CONFLICT");
        // Fresh target eligibility: receipt does not reactivate suspended work.
        const membership = await tx.companyMembership.findFirst({ where: { id: previous.companyMembershipId,
          userId: previous.userId, companyId: previous.companyId, tenantId: previous.tenantId,
          tenantMembershipId: previous.tenantMembershipId, status: "active", company: { isActive: true,
            type: "company", tenantId: previous.tenantId }, tenant: { status: "active" },
          tenantMembership: { userId: previous.userId, tenantId: previous.tenantId, status: "active" } }, select: { id: true } });
        if (!membership) return denied("ONBOARDING_RESULT_UNAVAILABLE");
        return project(previous);
      }
      if (!hash) return denied("ONBOARDING_CREDENTIAL_REQUIRED");
      // Never adopt/link an existing identity, even if it is currently unbound.
      await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${"tenant-onboarding-email:" + intent.administrator.email}, 0))) AS lock`;
      authenticatePermit(args.permit, args.signature, intent.operationId, fingerprint);
      if (await tx.user.findFirst({ where: { email: { equals: intent.administrator.email, mode: "insensitive" } }, select: { id: true } })) return denied("ONBOARDING_IDENTITY_EXISTS");
      const permissions = await tx.permission.findMany({ where: { key: { in: grantKeys } }, select: { id: true, key: true } });
      if (permissions.length !== grantKeys.length) return denied("ONBOARDING_CATALOG_INCOMPLETE");
      authenticatePermit(args.permit, args.signature, intent.operationId, fingerprint);
      const tenant = await tx.tenant.create({ data: { code: intent.tenant.code, name: intent.tenant.name, status: "active" }, select: { id: true } });
      const company = await tx.organization.create({ data: { ...intent.company, tenantId: tenant.id, type: "company", isActive: true }, select: { id: true } });
      const user = await tx.user.create({ data: { ...intent.administrator, password: hash }, select: { id: true } });
      const tenantMembership = await tx.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, status: "active" }, select: { id: true } });
      const membership = await tx.companyMembership.create({ data: { tenantId: tenant.id, tenantMembershipId: tenantMembership.id,
        companyId: company.id, userId: user.id, status: "active" }, select: { id: true } });
      const role = await tx.role.create({ data: { companyId: company.id, code: intent.profileRevision,
        name: "Initial operational administrator", isSystem: false, isOwnerRole: false }, select: { id: true } });
      await tx.rolePermission.createMany({ data: permissions.map(p => ({ roleId: role.id, permissionId: p.id })) });
      await tx.membershipRole.create({ data: { membershipId: membership.id, roleId: role.id } });
      await tx.membershipScope.create({ data: { membershipId: membership.id, scopeType: "company", scopeRefId: company.id } });
      const result = { tenantId: tenant.id, companyId: company.id, userId: user.id,
        tenantMembershipId: tenantMembership.id, companyMembershipId: membership.id, roleId: role.id };
      // This append-only receipt IS the accepted operator audit fact. No secret,
      // password hash, permit signature or external effect is persisted here.
      await tx.$executeRaw`INSERT INTO "TenantOnboardingReceipt" ("operationId", "operatorId", "keyFingerprint", "profileRevision", "intentFingerprint", "reason", "tenantId", "companyId", "userId", "tenantMembershipId", "companyMembershipId", "roleId") VALUES (${intent.operationId}::uuid, ${current.operatorId}, ${current.keyFingerprint}, ${current.profileRevision}, ${fingerprint}, ${intent.reason}, ${result.tenantId}::uuid, ${result.companyId}::uuid, ${result.userId}::uuid, ${result.tenantMembershipId}::uuid, ${result.companyMembershipId}::uuid, ${result.roleId}::uuid)`;
      if (intent.profileRevision === ONBOARDING_PROFILE_V2) {
        await tx.$executeRaw`INSERT INTO "CompanyDelegationAuthority" ("membershipId","userId","tenantId","companyId","tenantMembershipId","ceilingRevision") VALUES (${membership.id}::uuid,${user.id}::uuid,${tenant.id}::uuid,${company.id}::uuid,${tenantMembership.id}::uuid,'operational-delegation.v1')`;
        await tx.$executeRaw`INSERT INTO "CompanyDelegationAction" ("operationId","tenantId","companyId",action,fingerprint,"operatorId","operatorKeyFingerprint","targetMembershipId",reason,result) VALUES (${intent.operationId}::uuid,${tenant.id}::uuid,${company.id}::uuid,'operator-authorize',${fingerprint},${current.operatorId},${current.keyFingerprint},${membership.id}::uuid,${intent.reason},${JSON.stringify(result)}::jsonb)`;
      }
      return result;
    }, { maxWait: 5000, timeout: 15000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return denied("ONBOARDING_CONFLICT");
    if (error instanceof Error && "code" in error && String(error.code).startsWith("ONBOARDING_")) throw error;
    return denied("ONBOARDING_TRANSACTION_FAILED");
  }
}

function project(value: Result): Result {
  return { tenantId: value.tenantId, companyId: value.companyId, userId: value.userId,
    tenantMembershipId: value.tenantMembershipId, companyMembershipId: value.companyMembershipId, roleId: value.roleId };
}
