import prisma from "../config/prismaClient";

export async function getNextOrderNumber(): Promise<string> {
  // one row in Counter: { key: "orderNumber", value: 0 }
  const counter = await prisma.counter.upsert({
    where: { key: "orderNumber" },
    update: { value: { increment: 1 } },
    create: { key: "orderNumber", value: 1 },
  });

  // Example format: 99 + 6 digits => 99000001
  const seq = String(counter.value).padStart(10, "0");
  return `99${seq}`;
}
