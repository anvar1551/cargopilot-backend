import prisma from "../../../config/prismaClient";
import {
  createInvoice,
  createStripePayment,
} from "../../invoice-core/application/invoiceRepo";
import { createOrder, getOrderById } from "../repo";
import {
  CreateOrderRepoPayload,
  mapCreateOrderDtoToRepoPayload,
} from "../domain/orderCreate.mapper";
import { requireOrderActor } from "../shared";
import {
  enqueueOrderLabelJob,
  generateAndAttachParcelLabelsForOrder,
} from "../label";

type CreateOrderForActorArgs = {
  user: Express.User | undefined;
  body: unknown;
};

export async function createOrderForActor(args: CreateOrderForActorArgs) {
  const { user, body } = args;
  const paymentsEnabled = process.env.PAYMENTS_ENABLED === "true";
  const rawLabelMode = process.env.ORDER_LABEL_MODE;
  const labelMode =
    rawLabelMode === "async" || rawLabelMode === "queue" || rawLabelMode === "sync"
      ? rawLabelMode
      : "queue";
  const blockLabelWork = process.env.ORDER_LABEL_BLOCKING === "true";

  if (!user?.id) {
    const err = new Error("Unauthorized") as Error & { statusCode: number };
    err.statusCode = 401;
    throw err;
  }
  const actor = requireOrderActor(user);
  const mapped = await mapCreateOrderDtoToRepoPayload(body);

  mapped.customerEntityId = mapped.customerEntityId ?? user.customerEntityId ?? null;

  const { amount, ...repoPayload } = mapped as CreateOrderRepoPayload;
  const order = await createOrder(user.id, repoPayload, actor);
  let labelWarning: string | null = null;

  const runLabelWork = async () => {
    if (labelMode === "queue") {
      await enqueueOrderLabelJob(order.id);
    } else {
      await generateAndAttachParcelLabelsForOrder(order.id);
    }
  };

  if (blockLabelWork) {
    try {
      await runLabelWork();
    } catch (labelErr: any) {
      labelWarning =
        labelErr?.message ??
        "Order created, but parcel label generation failed";
      console.error(`Label generation failed for order ${order.id}:`, labelErr);
    }
  } else {
    void runLabelWork().catch((labelErr) => {
      console.error(`Label generation failed for order ${order.id}:`, labelErr);
    });
  }

  if (!paymentsEnabled) {
    return {
      statusCode: 201,
      payload: {
        order,
        warning: labelWarning,
        message:
          blockLabelWork
            ? labelWarning
              ? "Order created (manual payment) + parcel labels pending retry"
              : "Order created (manual payment) + parcel labels generated"
            : labelMode === "async" || labelMode === "sync"
              ? "Order created (manual payment) + parcel labels scheduled"
              : labelMode === "queue"
                ? "Order created (manual payment) + parcel labels queued"
                : "Order created (manual payment)",
      },
    };
  }

  if (typeof amount !== "number" || amount <= 0) {
    const err = new Error(
      "amount must be > 0 when PAYMENTS_ENABLED=true",
    ) as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }

  const invoice = await createInvoice(order.id, user.id, amount);

  const paymentUrl = await createStripePayment(order.id, invoice.id, amount, user.email);

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { paymentUrl },
  });

  const fresh = await getOrderById(order.id);
  return {
    statusCode: 201,
    payload: {
      order: fresh,
      invoice,
      paymentUrl,
      warning: labelWarning,
      message:
        blockLabelWork
          ? labelWarning
            ? "Order + invoice created successfully (parcel labels pending retry)"
            : "Order + parcel labels + invoice created successfully"
          : labelMode === "async" || labelMode === "sync"
            ? "Order + invoice created successfully (parcel labels scheduled)"
            : labelMode === "queue"
              ? "Order + invoice created successfully (parcel labels queued)"
              : "Order + invoice created successfully",
    },
  };
}
