import prisma from "../../config/prismaClient";

export async function getManagerOverview() {
  // 1️⃣ Total orders
  const totalOrders = await prisma.order.count();

  // 2️⃣ Pending orders
  const pendingOrders = await prisma.order.count({
    where: { status: "pending" },
  });

  // 3️⃣ Active drivers (drivers who have assigned orders)
  const activeDrivers = await prisma.user.count({
    where: {
      role: "driver",
      driverOrders: { some: {} },
    },
  });

  // 4️⃣ Total revenue (sum of paid invoices)
  const paidInvoices = await prisma.invoice.aggregate({
    _sum: { amount: true },
    where: { status: "paid" },
  });

  const totalRevenue = paidInvoices._sum.amount || 0;

  // 5️⃣ Pending invoices
  const pendingInvoices = await prisma.invoice.count({
    where: { status: "pending" },
  });

  return {
    totalOrders,
    pendingOrders,
    activeDrivers,
    totalRevenue,
    pendingInvoices,
  };
}
