import { Prisma, PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import type { AppUser } from "../../../types/app-user";
import { lockCredentialUser } from "./credential-lock";
import { lockRefreshContext } from "./refresh-lineage";
import { hasLiveAccessSession } from "./access-session";
import { authenticateControlledOperatorPermit, ONBOARDING_PROFILE_V2 } from "./tenant-onboarding";
import { clearIdentityAccessCacheForUser } from "../access-control";
import { DELEGATION_REVISION, OPERATIONAL_PROFILES, delegationFingerprint, operationIdSchema,
  reasonSchema, warehouseIdsSchema, type OperationalProfile } from "./operational-profiles";

const options = { maxWait: 3000, timeout: 15000 };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const emailSchema = z.string().trim().max(254).email().transform(v => v.toLowerCase());
function fail(code: string, statusCode = 403): never { throw Object.assign(new Error(code), { code, statusCode }); }
type Context = { id: string; tenantId: string; companyId: string; tenantMembershipId: string; companyMembershipId: string };
type Tx = Prisma.TransactionClient;
type Authority = { membershipId: string; userId: string; tenantId: string; companyId: string; tenantMembershipId: string;
  ceilingRevision: string; warehouseIds: string[]; enabled: boolean };
type Invitation = { id: string; operationId: string; tenantId: string; companyId: string; inviterMembershipId: string;
  email: string; profileRevision: OperationalProfile; warehouseIds: string[]; fingerprint: string; expiresAt: Date;
  state: string; acceptedMembershipId: string | null };

function context(actor: AppUser): Context {
  if (!actor || actor.membershipId !== actor.companyMembershipId ||
    ![actor.id, actor.tenantId, actor.companyId, actor.tenantMembershipId, actor.companyMembershipId].every(v => operationIdSchema.safeParse(v).success))
    return fail("DELEGATION_CONTEXT_REQUIRED");
  return { id: actor.id, tenantId: actor.tenantId!, companyId: actor.companyId!,
    tenantMembershipId: actor.tenantMembershipId!, companyMembershipId: actor.companyMembershipId! };
}
async function member(tx: Tx, id: string, lock = false) {
  if (lock) await tx.$queryRaw`SELECT id FROM "CompanyMembership" WHERE id=${id}::uuid FOR UPDATE`;
  const m = await tx.companyMembership.findUnique({ where: { id }, include: { user: { select: { id: true, email: true } },
    company: { select: { id: true, tenantId: true, type: true, isActive: true } }, tenant: { select: { id: true, status: true } },
    tenantMembership: { select: { id: true, userId: true, tenantId: true, status: true } },
    roles: { include: { role: { include: { rolePermissions: { include: { permission: { select: { key: true } } } } } } } }, scopes: true } });
  if (!m || m.status !== "active" || !m.tenantId || !m.tenantMembershipId || m.tenant?.status !== "active" ||
    m.company.tenantId !== m.tenantId || !m.company.isActive || m.company.type !== "company" ||
    m.tenantMembership?.status !== "active" || m.tenantMembership.userId !== m.userId || m.tenantMembership.tenantId !== m.tenantId)
    return fail("DELEGATION_MEMBERSHIP_UNAVAILABLE");
  return m;
}
function keys(m: Awaited<ReturnType<typeof member>>) {
  return m.roles.flatMap(r => r.role.companyId === m.companyId && !r.role.isSystem
    ? r.role.rolePermissions.map(p => p.permission.key) : []);
}
function agrees(m: Awaited<ReturnType<typeof member>>, c: Context) {
  if (m.userId !== c.id || m.tenantId !== c.tenantId || m.companyId !== c.companyId || m.tenantMembershipId !== c.tenantMembershipId || m.id !== c.companyMembershipId)
    fail("DELEGATION_CONTEXT_CONFLICT");
}
async function authority(tx: Tx, c: Context, inviting = false) {
  // Same membership -> authority order as the controlled owner mutations.
  const m = await member(tx, c.companyMembershipId, true); agrees(m, c);
  const rows = await tx.$queryRaw<Authority[]>`SELECT * FROM "CompanyDelegationAuthority" WHERE "membershipId"=${c.companyMembershipId}::uuid FOR UPDATE`;
  const a = rows[0];
  if (!a?.enabled || a.ceilingRevision !== DELEGATION_REVISION || a.userId !== c.id || a.tenantId !== c.tenantId ||
    a.companyId !== c.companyId || a.tenantMembershipId !== c.tenantMembershipId ||
    !keys(m).includes("membership.delegateOperational") || (inviting && !keys(m).includes("membership.invite")) ||
    !m.scopes.some(s => s.scopeType === "company" && s.scopeRefId === c.companyId)) fail("DELEGATION_AUTHORITY_REQUIRED");
  return a;
}
async function ownedWarehouses(tx: Tx, tenantId: string, ids: string[]) {
  if (!ids.length) return;
  const rows = await tx.warehouse.findMany({ where: { id: { in: ids }, tenantId }, select: { id: true } });
  if (rows.length !== ids.length) fail("DELEGATION_FOREIGN_SCOPE");
}
async function withinCeiling(tx: Tx, a: Authority, profile: OperationalProfile, ids: string[]) {
  if (!(profile in OPERATIONAL_PROFILES) || (profile === "operational-warehouse.v1") !== (ids.length > 0)) fail("DELEGATION_PROFILE_REJECTED");
  if (ids.some(id => !a.warehouseIds.includes(id))) fail("DELEGATION_SCOPE_CEILING");
  await ownedWarehouses(tx, a.tenantId, ids);
}
async function operationLock(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(${"company-delegation:" + id},0))) AS held`;
}
async function previous(tx: Tx, id: string, action: string, fingerprint: string, c: Context | { tenantId: string; companyId: string }, operator = false) {
  const rows = await tx.$queryRaw<any[]>`SELECT * FROM "CompanyDelegationAction" WHERE "operationId"=${id}::uuid`;
  const p = rows[0];
  if (p && (p.action !== action || p.fingerprint !== fingerprint || p.tenantId !== c.tenantId || p.companyId !== c.companyId ||
    (operator ? p.operatorId !== "cargopilot-bootstrap-owner" : p.actorUserId !== (c as Context).id || p.actorMembershipId !== (c as Context).companyMembershipId)))
    fail("DELEGATION_OPERATION_CONFLICT", 409);
  return p?.result;
}
async function audit(tx: Tx, operationId: string, action: string, fingerprint: string,
  c: Context | { tenantId: string; companyId: string }, reason: string, result: object, targetId: string | null, operator = false, recipientUserId: string | null = null, operatorKeyFingerprint: string | null = null) {
  const actor = c as Context;
  await tx.$executeRaw`INSERT INTO "CompanyDelegationAction" ("operationId","tenantId","companyId",action,fingerprint,"actorUserId","actorMembershipId","operatorId","targetMembershipId",reason,result,"recipientUserId","operatorKeyFingerprint")
    VALUES (${operationId}::uuid,${c.tenantId}::uuid,${c.companyId}::uuid,${action},${fingerprint},${operator ? null : actor.id}::uuid,
      ${operator ? null : actor.companyMembershipId}::uuid,${operator ? "cargopilot-bootstrap-owner" : null},${targetId}::uuid,${reason},${JSON.stringify(result)}::jsonb,${recipientUserId}::uuid,${operatorKeyFingerprint})`;
}
async function revokeContextSessions(tx: Tx, m: Awaited<ReturnType<typeof member>>) {
  await lockRefreshContext(tx, { userId: m.userId, tenantId: m.tenantId, tenantMembershipId: m.tenantMembershipId, companyMembershipId: m.id });
  await tx.userRefreshSession.updateMany({ where: { userId: m.userId, companyMembershipId: m.id, tenantId: m.tenantId, revokedAt: null }, data: { revokedAt: new Date() } });
  await tx.$executeRaw`UPDATE "CompanyMembership" SET "authorizationVersion"="authorizationVersion"+1 WHERE id=${m.id}::uuid`;
}
async function staticRole(tx: Tx, companyId: string, code: string, permissions: readonly string[]) {
  const catalog = await tx.permission.findMany({ where: { key: { in: [...permissions] } }, select: { id: true } });
  if (catalog.length !== permissions.length) fail("DELEGATION_CATALOG_INCOMPLETE");
  const role = await tx.role.upsert({ where: { companyId_code: { companyId, code } }, create: { companyId, code, name: code,
    rolePermissions: { create: catalog.map(p => ({ permissionId: p.id })) } }, update: {},
    include: { rolePermissions: { include: { permission: { select: { key: true } } } } } });
  if (role.isSystem || role.isOwnerRole || JSON.stringify(role.rolePermissions.map(p => p.permission.key).sort()) !== JSON.stringify([...permissions].sort())) fail("DELEGATION_ROLE_CONFLICT");
  return role;
}

const operatorSchema = z.object({ operationId: operationIdSchema, membershipId: operationIdSchema,
  action: z.enum(["operator-authorize", "operator-revoke"]), warehouseIds: warehouseIdsSchema,
  ceilingRevision: z.literal(DELEGATION_REVISION), profileRevision: z.literal(ONBOARDING_PROFILE_V2), reason: reasonSchema }).strict();
/** Internal owner mechanism only. No HTTP route, default registry or automatic signing. */
export async function authorizeCompanyDelegator(db: PrismaClient, args: { intent: unknown; permit: unknown; signature: string }) {
  const v = operatorSchema.parse(args.intent), fingerprint = delegationFingerprint("operator-authority", v);
  const authenticate = () => authenticateControlledOperatorPermit(args.permit, args.signature, v.operationId, fingerprint, ONBOARDING_PROFILE_V2);
  authenticate();
  const found = await db.companyMembership.findUnique({ where: { id: v.membershipId }, select: { userId: true } });
  if (!found) return fail("DELEGATION_MEMBERSHIP_UNAVAILABLE");
  return db.$transaction(async tx => {
    await lockCredentialUser(tx, found.userId); await operationLock(tx, v.operationId);
    const m = await member(tx, v.membershipId, true), c = { tenantId: m.tenantId!, companyId: m.companyId };
    authenticate(); await ownedWarehouses(tx, c.tenantId, v.warehouseIds);
    const old = await previous(tx, v.operationId, v.action, fingerprint, c, true);
    if (old) return old;
    if (v.action === "operator-authorize") {
      if (m.roles.some(r => r.role.isSystem || r.role.isOwnerRole || r.role.companyId !== m.companyId) ||
        !m.scopes.some(s => s.scopeType === "company" && s.scopeRefId === m.companyId)) fail("DELEGATION_TARGET_NOT_COMPANY_ADMIN");
      const role = await staticRole(tx, m.companyId, "company-delegator.v1", ["membership.invite", "membership.delegateOperational"]);
      await tx.membershipRole.upsert({ where: { membershipId_roleId: { membershipId: m.id, roleId: role.id } }, create: { membershipId: m.id, roleId: role.id }, update: {} });
      await tx.$executeRaw`INSERT INTO "CompanyDelegationAuthority" ("membershipId","userId","tenantId","companyId","tenantMembershipId","ceilingRevision","warehouseIds")
        VALUES (${m.id}::uuid,${m.userId}::uuid,${m.tenantId}::uuid,${m.companyId}::uuid,${m.tenantMembershipId}::uuid,${DELEGATION_REVISION},${v.warehouseIds}::uuid[])
        ON CONFLICT ("membershipId") DO UPDATE SET "warehouseIds"=EXCLUDED."warehouseIds",enabled=true`;
    } else {
      // Common order: membership -> authority -> invitation (also acceptance/cancellation).
      await tx.$queryRaw`SELECT "membershipId" FROM "CompanyDelegationAuthority" WHERE "membershipId"=${m.id}::uuid FOR UPDATE`;
      await tx.$executeRaw`UPDATE "CompanyDelegationAuthority" SET enabled=false WHERE "membershipId"=${m.id}::uuid`;
      await tx.$executeRaw`UPDATE "CompanyInvitation" SET state='cancelled' WHERE "inviterMembershipId"=${m.id}::uuid AND state='pending'`;
    }
    await revokeContextSessions(tx, m); const acceptedAuthority = authenticate();
    const result = { companyMembershipId: m.id, enabled: v.action === "operator-authorize", ceilingRevision: DELEGATION_REVISION };
    await audit(tx, v.operationId, v.action, fingerprint, c, v.reason, result, m.id, true, null, acceptedAuthority.keyFingerprint); return result;
  }, options).finally(() => clearIdentityAccessCacheForUser(found.userId));
}

const inviteSchema = z.object({ operationId: operationIdSchema, email: emailSchema,
  profileRevision: z.enum(["operational-clerk.v1", "operational-dispatcher.v1", "operational-warehouse.v1"]),
  warehouseIds: warehouseIdsSchema, reason: reasonSchema }).strict();
export async function createCompanyInvitation(db: PrismaClient, actor: AppUser, input: unknown) {
  const c = context(actor), v = inviteSchema.parse(input);
  if (v.email === actor.email?.trim().toLowerCase()) fail("DELEGATION_SELF_CHANGE");
  const fingerprint = delegationFingerprint("invite", { ...c, ...v }), token = randomBytes(32).toString("base64url");
  return db.$transaction(async tx => {
    await lockCredentialUser(tx, c.id); await operationLock(tx, v.operationId);
    const a = await authority(tx, c, true); await withinCeiling(tx, a, v.profileRevision, v.warehouseIds);
    if ((await member(tx, c.companyMembershipId)).user.email.toLowerCase() === v.email) fail("DELEGATION_SELF_CHANGE");
    const old = await previous(tx, v.operationId, "invite", fingerprint, c); if (old) return old; // Raw token never persisted/recovered.
    const rows = await tx.$queryRaw<Array<{ id: string; expiresAt: Date }>>`INSERT INTO "CompanyInvitation" ("operationId","tenantId","companyId","inviterMembershipId",email,"profileRevision","warehouseIds",fingerprint,"tokenHash","expiresAt")
      VALUES (${v.operationId}::uuid,${c.tenantId}::uuid,${c.companyId}::uuid,${c.companyMembershipId}::uuid,${v.email},${v.profileRevision},${v.warehouseIds}::uuid[],${fingerprint},${digest(token)},CURRENT_TIMESTAMP+interval '72 hours') RETURNING id,"expiresAt"`;
    const result = { invitationId: rows[0].id, expiresAt: rows[0].expiresAt.toISOString(), delivery: "token-returned-once" };
    await audit(tx, v.operationId, "invite", fingerprint, c, v.reason, result, null);
    return { ...result, token };
  }, options);
}

const acceptanceSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  operationId: operationIdSchema, name: z.string().trim().min(1).max(160).regex(/^[^\u0000-\u001f\u007f]+$/).optional(),
  password: z.string().min(12).max(72).optional() }).strict();
/** Existing identity requires current verified access claims, never an email selector. */
export async function acceptCompanyInvitation(db: PrismaClient, input: unknown, accessToken?: string) {
  const v = acceptanceSchema.parse(input);
  const { isBoundAccessSession } = await import("./access-session");
  let claims: unknown;
  if (accessToken !== undefined) {
    try { claims = jwt.verify(accessToken, process.env.JWT_SECRET!, { algorithms: ["HS256"] }); }
    catch { fail("INVITATION_IDENTITY_REQUIRED", 401); }
    if (!isBoundAccessSession(claims) || !await hasLiveAccessSession(claims)) fail("INVITATION_IDENTITY_REQUIRED", 401);
  }
  if (v.password && (v.password.trim().length < 12 || Buffer.byteLength(v.password, "utf8") > 72 || /[\u0000-\u001f\u007f]/.test(v.password))) fail("INVITATION_CREDENTIAL_INVALID", 400);
  const hash = v.password ? await bcrypt.hash(v.password, 12) : null;
  return db.$transaction(async tx => {
    await operationLock(tx, v.operationId);
    await tx.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(${"invitation-token:" + digest(v.token)},0))) AS held`;
    // Routing hint only. State must be reloaded after acquiring inviter authority.
    const hint = (await tx.$queryRaw<Invitation[]>`SELECT * FROM "CompanyInvitation" WHERE "tokenHash"=${digest(v.token)}`)[0];
    if (!hint) fail("INVITATION_UNAVAILABLE");
    let inv = hint;
    await tx.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(${"tenant-onboarding-email:" + inv.email},0))) AS held`;
    let user = await tx.user.findFirst({ where: { email: { equals: inv.email, mode: "insensitive" } }, select: { id: true, email: true } });
    if (user) {
      if (!isBoundAccessSession(claims) || user.id !== claims.id || v.password !== undefined || v.name !== undefined) fail("INVITATION_IDENTITY_REQUIRED", 401);
      await lockCredentialUser(tx, user.id);
      // Serialize against refresh/logout, preserving valid predecessor access
      // claims whose recorded successor remains live. No uncommitted writes exist
      // yet: the shared authoritative reader observes the locked committed lineage.
      await lockRefreshContext(tx, { userId: claims.id, tenantId: claims.tenantId,
        tenantMembershipId: claims.tenantMembershipId, companyMembershipId: claims.companyMembershipId });
      if (!await hasLiveAccessSession(claims)) fail("INVITATION_IDENTITY_REQUIRED", 401);
      agrees(await member(tx, claims.companyMembershipId), { id: claims.id, tenantId: claims.tenantId, companyId: claims.companyId, tenantMembershipId: claims.tenantMembershipId, companyMembershipId: claims.companyMembershipId });
    } else if (claims !== undefined || !hash || !v.name) fail("INVITATION_NEW_CREDENTIAL_REQUIRED", 400);
    const inviter = await member(tx, inv.inviterMembershipId), c: Context = { id: inviter.userId, tenantId: inviter.tenantId!, companyId: inviter.companyId, tenantMembershipId: inviter.tenantMembershipId!, companyMembershipId: inviter.id };
    const a = await authority(tx, c, true);
    const locked = (await tx.$queryRaw<Invitation[]>`SELECT * FROM "CompanyInvitation" WHERE id=${hint.id}::uuid AND "tokenHash"=${digest(v.token)} FOR UPDATE`)[0];
    if (!locked || locked.email !== hint.email || locked.inviterMembershipId !== hint.inviterMembershipId) fail("INVITATION_CONTEXT_CONFLICT");
    inv = locked;
    if (inv.tenantId !== c.tenantId || inv.companyId !== c.companyId) fail("INVITATION_CONTEXT_CONFLICT");
    await withinCeiling(tx, a, inv.profileRevision, inv.warehouseIds);
    if (user?.id === inviter.userId) fail("DELEGATION_SELF_CHANGE");
    const fingerprint = delegationFingerprint("accept", { invitationId: inv.id, operationId: v.operationId });
    if (inv.state === "accepted") {
      const old = await previous(tx, v.operationId, "accept", fingerprint, c);
      if (!old || !user || inv.acceptedMembershipId !== old.companyMembershipId) fail("INVITATION_ALREADY_USED", 409);
      const m = await member(tx, old.companyMembershipId); if (m.userId !== user.id) fail("INVITATION_IDENTITY_REQUIRED", 401);
      return old;
    }
    if (inv.state !== "pending" || inv.expiresAt.getTime() <= Date.now()) fail("INVITATION_UNAVAILABLE");
    if (await previous(tx, v.operationId, "accept", fingerprint, c)) fail("INVITATION_OPERATION_CONFLICT", 409);
    if (!user) user = await tx.user.create({ data: { email: inv.email, name: v.name!, password: hash! }, select: { id: true, email: true } });
    if (await tx.companyMembership.findUnique({ where: { userId_companyId: { userId: user.id, companyId: c.companyId } }, select: { id: true } })) fail("INVITATION_EXISTING_MEMBERSHIP", 409);
    const tm = await tx.tenantMembership.upsert({ where: { tenantId_userId: { tenantId: c.tenantId, userId: user.id } }, create: { tenantId: c.tenantId, userId: user.id }, update: {} });
    if (tm.status !== "active") fail("INVITATION_TENANT_MEMBERSHIP_UNAVAILABLE");
    const m = await tx.companyMembership.create({ data: { tenantId: c.tenantId, companyId: c.companyId, userId: user.id, tenantMembershipId: tm.id } });
    await applyProfile(tx, m.id, inv.profileRevision, inv.warehouseIds, { creating: true });
    const changed = await tx.$executeRaw`UPDATE "CompanyInvitation" SET state='accepted',"acceptedMembershipId"=${m.id}::uuid WHERE id=${inv.id}::uuid AND state='pending'`;
    if (changed !== 1) fail("INVITATION_STATE_CONFLICT", 409);
    const result = { companyMembershipId: m.id, tenantId: c.tenantId, companyId: c.companyId, tenantMembershipId: tm.id, userId: user.id };
    await audit(tx, v.operationId, "accept", fingerprint, c, "Recipient accepted approved invitation", result, m.id, false, user.id);
    return result;
  }, options);
}

export async function cancelCompanyInvitation(db: PrismaClient, actor: AppUser, input: unknown) {
  const c = context(actor), v = z.object({ operationId: operationIdSchema, invitationId: operationIdSchema, reason: reasonSchema }).strict().parse(input);
  const fingerprint = delegationFingerprint("cancel", { ...c, ...v });
  return db.$transaction(async tx => {
    await lockCredentialUser(tx, c.id); await operationLock(tx, v.operationId); await authority(tx, c, true);
    const inv = (await tx.$queryRaw<Invitation[]>`SELECT * FROM "CompanyInvitation" WHERE id=${v.invitationId}::uuid AND "tenantId"=${c.tenantId}::uuid AND "companyId"=${c.companyId}::uuid AND "inviterMembershipId"=${c.companyMembershipId}::uuid FOR UPDATE`)[0];
    if (!inv) fail("INVITATION_UNAVAILABLE");
    const old = await previous(tx, v.operationId, "cancel", fingerprint, c); if (old) return old;
    if (inv.state !== "pending") fail("INVITATION_STATE_CONFLICT", 409);
    await tx.$executeRaw`UPDATE "CompanyInvitation" SET state='cancelled' WHERE id=${inv.id}::uuid`;
    const result = { invitationId: inv.id, state: "cancelled" };
    await audit(tx, v.operationId, "cancel", fingerprint, c, v.reason, result, null); return result;
  }, options);
}

async function applyProfile(tx: Tx, membershipId: string, profile: OperationalProfile, warehouseIds: string[], mode: { creating: true } | { authority: Authority }) {
  const creating = "creating" in mode;
  const m = await member(tx, membershipId, true);
  const current = (await tx.$queryRaw<any[]>`SELECT * FROM "CompanyOperationalGrant" WHERE "membershipId"=${m.id}::uuid FOR UPDATE`)[0];
  if ((!creating && !current) || (creating && (current || m.roles.length || m.scopes.length)) ||
    m.roles.some(r => r.roleId !== current?.roleId)) fail("DELEGATION_UNMANAGED_TARGET");
  if (current) assertManagedScopes(m, current);
  // Replacements remove the existing managed access, so authority must cover
  // that access as well as the requested profile. Disabled grants have no scopes.
  if (current?.enabled && "authority" in mode) await withinCeiling(tx, mode.authority, current.profileRevision, current.warehouseIds);
  await tx.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(${"operational-role:" + m.companyId + ":" + profile},0))) AS held`;
  const role = await staticRole(tx, m.companyId, profile, OPERATIONAL_PROFILES[profile]);
  await tx.membershipRole.deleteMany({ where: { membershipId: m.id } });
  await tx.membershipScope.deleteMany({ where: { membershipId: m.id } });
  await tx.membershipRole.create({ data: { membershipId: m.id, roleId: role.id } });
  await tx.membershipScope.createMany({ data: warehouseIds.length ? warehouseIds.map(id => ({ membershipId: m.id, scopeType: "warehouse" as const, scopeRefId: id })) : [{ membershipId: m.id, scopeType: "company", scopeRefId: m.companyId }] });
  await tx.$executeRaw`INSERT INTO "CompanyOperationalGrant" ("membershipId","userId","tenantId","companyId","tenantMembershipId","profileRevision","warehouseIds","roleId") VALUES (${m.id}::uuid,${m.userId}::uuid,${m.tenantId}::uuid,${m.companyId}::uuid,${m.tenantMembershipId}::uuid,${profile},${warehouseIds}::uuid[],${role.id}::uuid)
    ON CONFLICT ("membershipId") DO UPDATE SET "profileRevision"=EXCLUDED."profileRevision","warehouseIds"=EXCLUDED."warehouseIds","roleId"=EXCLUDED."roleId",enabled=true`;
  await revokeContextSessions(tx, m);
}
function assertManagedScopes(m: Awaited<ReturnType<typeof member>>, grant: { enabled: boolean; warehouseIds: string[] }) {
  const expected = !grant.enabled ? [] : grant.warehouseIds.length
    ? grant.warehouseIds.map(id => `warehouse:${id}`).sort() : [`company:${m.companyId}`];
  const actual = m.scopes.map(s => `${s.scopeType}:${s.scopeRefId}`).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("DELEGATION_UNMANAGED_SCOPES");
}
const mutationSchema = z.object({ operationId: operationIdSchema, membershipId: operationIdSchema,
  action: z.enum(["grant", "revoke"]), profileRevision: z.enum(["operational-clerk.v1", "operational-dispatcher.v1", "operational-warehouse.v1"]), warehouseIds: warehouseIdsSchema, reason: reasonSchema }).strict();
export async function mutateCompanyOperationalGrant(db: PrismaClient, actor: AppUser, input: unknown) {
  const c = context(actor), v = mutationSchema.parse(input);
  const target = await db.companyMembership.findUnique({ where: { id: v.membershipId }, select: { userId: true } });
  if (!target || target.userId === c.id) fail("DELEGATION_TARGET_REJECTED");
  const fingerprint = delegationFingerprint(v.action, { ...c, ...v });
  return db.$transaction(async tx => {
    for (const id of [c.id, target.userId].sort()) await lockCredentialUser(tx, id);
    await operationLock(tx, v.operationId); const a = await authority(tx, c);
    await withinCeiling(tx, a, v.profileRevision, v.warehouseIds);
    const m = await member(tx, v.membershipId, true);
    if (m.tenantId !== c.tenantId || m.companyId !== c.companyId) fail("DELEGATION_FOREIGN_TARGET");
    if ((await tx.$queryRaw<any[]>`SELECT 1 FROM "CompanyDelegationAuthority" WHERE "membershipId"=${m.id}::uuid`).length) fail("DELEGATION_TARGET_IS_DELEGATOR");
    const old = await previous(tx, v.operationId, v.action, fingerprint, c); if (old) return old;
    if (v.action === "grant") await applyProfile(tx, m.id, v.profileRevision, v.warehouseIds, { authority: a });
    else {
      const grant = (await tx.$queryRaw<any[]>`SELECT * FROM "CompanyOperationalGrant" WHERE "membershipId"=${m.id}::uuid FOR UPDATE`)[0];
      if (!grant || grant.profileRevision !== v.profileRevision || JSON.stringify([...grant.warehouseIds].sort()) !== JSON.stringify(v.warehouseIds) || m.roles.some(r => r.roleId !== grant.roleId)) fail("DELEGATION_TARGET_CONFLICT");
      assertManagedScopes(m, grant);
      await tx.membershipRole.deleteMany({ where: { membershipId: m.id, roleId: grant.roleId } });
      await tx.membershipScope.deleteMany({ where: { membershipId: m.id } });
      await tx.$executeRaw`UPDATE "CompanyOperationalGrant" SET enabled=false WHERE "membershipId"=${m.id}::uuid`;
      await revokeContextSessions(tx, m);
    }
    const result = { companyMembershipId: m.id, action: v.action, profileRevision: v.profileRevision };
    await audit(tx, v.operationId, v.action, fingerprint, c, v.reason, result, m.id); return result;
  }, options).finally(() => clearIdentityAccessCacheForUser(target.userId));
}
