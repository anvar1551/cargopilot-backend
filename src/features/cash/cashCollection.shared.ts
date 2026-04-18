import {
  CashCollectionEventType,
  CashCollectionKind,
  CashHolderType,
  PaidBy,
  PaidStatus,
  Prisma,
} from "@prisma/client";

import type { OrderActor } from "../../services/orders/orderService.shared";

type OrderCashSeedInput = {
  codAmount?: number | null;
  codPaidStatus?: PaidStatus | null;
  serviceCharge?: number | null;
  serviceChargePaidStatus?: PaidStatus | null;
  deliveryChargePaidBy?: PaidBy | null;
  currency?: string | null;
};

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function buildExpectedCollection(
  kind: CashCollectionKind,
  amount: number,
  currency: string | null | undefined,
  actor?: OrderActor,
): Prisma.CashCollectionCreateWithoutOrderInput {
  return {
    kind,
    expectedAmount: amount,
    currency: currency ?? null,
    events: {
      create: {
        eventType: CashCollectionEventType.expected,
        amount,
        note:
          kind === CashCollectionKind.cod
            ? "COD expected for this order"
            : "Service charge expected for this order",
        actorId: actor?.id ?? null,
        actorRole: actor?.role ?? null,
        toHolderType: CashHolderType.none,
        toHolderName: "Not collected yet",
      },
    },
  };
}

export function buildInitialOrderCashCollections(
  input: OrderCashSeedInput,
  actor?: OrderActor,
): Prisma.CashCollectionCreateWithoutOrderInput[] {
  const rows: Prisma.CashCollectionCreateWithoutOrderInput[] = [];

  if (
    isPositiveNumber(input.codAmount) &&
    input.codPaidStatus !== PaidStatus.PAID
  ) {
    rows.push(
      buildExpectedCollection(
        CashCollectionKind.cod,
        input.codAmount,
        input.currency,
        actor,
      ),
    );
  }

  if (
    isPositiveNumber(input.serviceCharge) &&
    input.serviceChargePaidStatus !== PaidStatus.PAID &&
    (input.deliveryChargePaidBy === PaidBy.SENDER ||
      input.deliveryChargePaidBy === PaidBy.RECIPIENT)
  ) {
    rows.push(
      buildExpectedCollection(
        CashCollectionKind.service_charge,
        input.serviceCharge,
        input.currency,
        actor,
      ),
    );
  }

  return rows;
}
