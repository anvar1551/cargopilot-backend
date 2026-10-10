import { createHash } from "crypto";
import { z } from "zod";
import prisma from "../../../config/prismaClient";
import { requireAcceptedDriver } from "../../identity-access/application/driver-eligibility";
import {
  requireCustodyActor,
  loadCustodySource,
  authorizeCustodyAction,
} from "../domain/custody-access";
import { orderError, type OrderActor } from "../shared";

const query = z
  .object({
    action: z.enum(["dispatch", "last-mile-offer"]),
    kind: z.enum(["drivers", "legs"]),
    limit: z.coerce.number().int().min(1).max(20).default(20),
    cursor: z.string().max(1024).optional(),
  })
  .strict();
const cursor = z
  .object({
    context: z.string().regex(/^[a-f0-9]{64}$/),
    after: z.string().uuid(),
  })
  .strict();
/** Suggestions never grant authority. Execution revalidates the exact source and nomination. */
export async function readCustodyOptions(
  requested: OrderActor,
  orderId: string,
  raw: unknown,
) {
  const parsed = query.safeParse(raw);
  if (!parsed.success || !z.string().uuid().safeParse(orderId).success)
    throw orderError("Invalid custody options", 400);
  const p = parsed.data,
    a = await requireCustodyActor(requested, `shipment.custody.${p.action}`);
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'");
      const source = await loadCustodySource(tx, a, orderId);
      await authorizeCustodyAction(tx, a, source, p.action);
      if (source.order.status !== "at_warehouse" || !source.latest?.warehouseId)
        throw orderError("Warehouse custody required", 409);
      if (p.kind === "legs" && p.action !== "dispatch")
        throw orderError("Transport legs require dispatch", 400);
      const context = createHash("sha256")
        .update(
          JSON.stringify([
            a.id,
            a.tenantId,
            a.companyId,
            a.companyMembershipId,
            a.tenantMembershipId,
            orderId,
            source.latest.id,
            source.order.updatedAt,
            p.action,
            p.kind,
            p.limit,
          ]),
        )
        .digest("hex");
      let after: string | undefined;
      if (p.cursor) {
        try {
          const c = cursor.parse(
            JSON.parse(Buffer.from(p.cursor, "base64url").toString()),
          );
          if (
            c.context !== context ||
            Buffer.from(JSON.stringify(c)).toString("base64url") !== p.cursor
          )
            throw Error();
          after = c.after;
        } catch {
          throw orderError(
            "Invalid or changed-context custody options cursor",
            400,
          );
        }
      }
      let items: Array<{
          id: string;
          name: string;
          destinationWarehouseId?: string;
        }>,
        last: string | undefined,
        more: boolean;
      if (p.kind === "legs") {
        const rows = await tx.orderLeg.findMany({
          where: {
            orderId,
            order: { tenantId: a.tenantId!, ownerOrgId: a.companyId! },
            status: "planned",
            fromWarehouseId: source.latest.warehouseId,
            toWarehouseId: { not: source.latest.warehouseId },
            toWarehouse: { tenantId: a.tenantId! },
            fromWarehouse: { tenantId: a.tenantId! },
            carrierProviderId: null,
            carrierBookingStatus: "not_requested",
            ...(after ? { id: { gt: after } } : {}),
          },
          select: {
            id: true,
            sequence: true,
            toWarehouseId: true,
            toWarehouse: { select: { name: true } },
          },
          orderBy: { id: "asc" },
          take: p.limit + 1,
        });
        more = rows.length > p.limit;
        const page = rows.slice(0, p.limit);
        last = page[page.length - 1]?.id;
        items = page.map((r) => ({
          id: r.id,
          name: `Leg ${r.sequence} → ${r.toWarehouse!.name}`,
          destinationWarehouseId: r.toWarehouseId!,
        }));
      } else {
        const type = p.action === "dispatch" ? "linehaul" : "local",
          permission =
            p.action === "dispatch"
              ? "shipment.custody.transport-accept"
              : "shipment.custody.last-mile-accept";
        const rows = await tx.companyDriverEligibility.findMany({
          where: {
            tenantId: a.tenantId!,
            companyId: a.companyId!,
            enabled: true,
            driverType: type,
            ...(after ? { membershipId: { gt: after } } : {}),
          },
          select: {
            membershipId: true,
            member: { select: { user: { select: { name: true } } } },
          },
          orderBy: { membershipId: "asc" },
          take: p.limit + 1,
        });
        more = rows.length > p.limit;
        const page = rows.slice(0, p.limit);
        last = page[page.length - 1]?.membershipId;
        items = [];
        for (const r of page) {
          try {
            await requireAcceptedDriver(
              tx,
              { tenantId: a.tenantId!, companyId: a.companyId! },
              r.membershipId,
              type,
              permission,
            );
            items.push({
              id: r.membershipId,
              name: r.member.user.name || "Unnamed driver",
            });
          } catch (error) {
            if ((error as { statusCode?: number }).statusCode !== 403)
              throw error;
          }
        }
      }
      return {
        items,
        nextCursor:
          more && last
            ? Buffer.from(JSON.stringify({ context, after: last })).toString(
                "base64url",
              )
            : null,
      };
    },
    { maxWait: 2000, timeout: 10000 },
  );
}
