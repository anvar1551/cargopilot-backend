import "dotenv/config";
import {
  SupportTicketPriority,
  SupportTicketSource,
} from "@prisma/client";
import prisma from "../config/prismaClient";

const ROOT_COMPANY_CODE = "CP_ROOT";

const DEFAULT_QUEUES = [
  {
    code: "operations",
    name: "Operations",
    description: "Shipment exceptions, SLA risk, pickup and delivery issues.",
    isDefault: true,
  },
  {
    code: "finance",
    name: "Finance",
    description: "Payments, invoices, refunds, COD, and cash settlement issues.",
    isDefault: false,
  },
  {
    code: "integrations",
    name: "Integrations",
    description: "Carrier, webhook, label, and external provider failures.",
    isDefault: false,
  },
  {
    code: "customer_service",
    name: "Customer Service",
    description: "Customer chat, address changes, complaints, and general requests.",
    isDefault: false,
  },
  {
    code: "driver_support",
    name: "Driver Support",
    description: "Driver app, route, pickup proof, delivery proof, and telemetry issues.",
    isDefault: false,
  },
] as const;

const DEFAULT_RULES = [
  {
    code: "system_alert_payment_finance",
    name: "Payment support alerts",
    queueCode: "finance",
    source: SupportTicketSource.system_alert,
    priority: null,
    conditionsJson: { routingKey: "payment" },
    sortOrder: 10,
  },
  {
    code: "system_alert_carrier_integrations",
    name: "Carrier integration alerts",
    queueCode: "integrations",
    source: SupportTicketSource.system_alert,
    priority: null,
    conditionsJson: { routingKey: "carrier" },
    sortOrder: 20,
  },
  {
    code: "system_alert_label_integrations",
    name: "Label generation alerts",
    queueCode: "integrations",
    source: SupportTicketSource.system_alert,
    priority: null,
    conditionsJson: { routingKey: "label" },
    sortOrder: 30,
  },
  {
    code: "system_alert_order_stale_operations",
    name: "Stale order operations alerts",
    queueCode: "operations",
    source: SupportTicketSource.system_alert,
    priority: null,
    conditionsJson: { routingKey: "order_stale" },
    sortOrder: 40,
  },
  {
    code: "driver_app_driver_support",
    name: "Driver app tickets",
    queueCode: "driver_support",
    source: SupportTicketSource.driver_app,
    priority: null,
    conditionsJson: {},
    sortOrder: 50,
  },
  {
    code: "customer_chat_customer_service",
    name: "Customer chat tickets",
    queueCode: "customer_service",
    source: SupportTicketSource.customer_chat,
    priority: null,
    conditionsJson: {},
    sortOrder: 60,
  },
  {
    code: "manager_operations",
    name: "Manager-created operations tickets",
    queueCode: "operations",
    source: SupportTicketSource.manager,
    priority: null,
    conditionsJson: {},
    sortOrder: 70,
  },
] as const;

const DISABLED_LEGACY_RULE_CODES = [
  "system_alert_urgent_integrations",
  "system_alert_high_integrations",
] as const;

const DEFAULT_SLA_POLICIES = [
  { code: "global_normal_24h", name: "Global normal response", queueCode: null, priority: SupportTicketPriority.normal, targetMinutes: 24 * 60, warningMinutes: 18 * 60 },
  { code: "global_high_8h", name: "Global high response", queueCode: null, priority: SupportTicketPriority.high, targetMinutes: 8 * 60, warningMinutes: 6 * 60 },
  { code: "global_urgent_2h", name: "Global urgent response", queueCode: null, priority: SupportTicketPriority.urgent, targetMinutes: 2 * 60, warningMinutes: 90 },
  { code: "finance_high_4h", name: "Finance high response", queueCode: "finance", priority: SupportTicketPriority.high, targetMinutes: 4 * 60, warningMinutes: 3 * 60 },
  { code: "finance_urgent_1h", name: "Finance urgent response", queueCode: "finance", priority: SupportTicketPriority.urgent, targetMinutes: 60, warningMinutes: 45 },
  { code: "integrations_high_4h", name: "Integrations high response", queueCode: "integrations", priority: SupportTicketPriority.high, targetMinutes: 4 * 60, warningMinutes: 3 * 60 },
  { code: "integrations_urgent_1h", name: "Integrations urgent response", queueCode: "integrations", priority: SupportTicketPriority.urgent, targetMinutes: 60, warningMinutes: 45 },
  { code: "driver_support_high_4h", name: "Driver support high response", queueCode: "driver_support", priority: SupportTicketPriority.high, targetMinutes: 4 * 60, warningMinutes: 3 * 60 },
  { code: "driver_support_urgent_1h", name: "Driver support urgent response", queueCode: "driver_support", priority: SupportTicketPriority.urgent, targetMinutes: 60, warningMinutes: 45 },
] as const;

async function resolveCompanyId() {
  const explicitCompanyId = String(process.env.SUPPORT_BOOTSTRAP_COMPANY_ID ?? "").trim();
  if (explicitCompanyId) return explicitCompanyId;

  const root = await prisma.organization.findFirst({
    where: { code: ROOT_COMPANY_CODE, type: "company" },
    select: { id: true },
  });
  if (root) return root.id;

  const firstCompany = await prisma.organization.findFirst({
    where: { type: "company", isActive: true },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (firstCompany) return firstCompany.id;

  throw new Error(
    "No active company found. Run bootstrap:erp-access first or set SUPPORT_BOOTSTRAP_COMPANY_ID.",
  );
}

async function main() {
  const companyId = await resolveCompanyId();

  const queuesByCode = new Map<string, { id: string; code: string }>();
  for (const queue of DEFAULT_QUEUES) {
    const saved = await prisma.$transaction(async (tx) => {
      if (queue.isDefault) {
        await tx.supportQueue.updateMany({
          where: { companyId, isDefault: true, code: { not: queue.code } },
          data: { isDefault: false },
        });
      }
      return tx.supportQueue.upsert({
        where: { companyId_code: { companyId, code: queue.code } },
        create: {
          companyId,
          code: queue.code,
          name: queue.name,
          description: queue.description,
          isDefault: Boolean(queue.isDefault),
          isActive: true,
        },
        update: {
          name: queue.name,
          description: queue.description,
          isDefault: Boolean(queue.isDefault),
          isActive: true,
        },
        select: { id: true, code: true },
      });
    });
    queuesByCode.set(saved.code, saved);
  }

  for (const rule of DEFAULT_RULES) {
    const queue = queuesByCode.get(rule.queueCode);
    if (!queue) throw new Error(`Queue ${rule.queueCode} was not created`);
    await prisma.supportAssignmentRule.upsert({
      where: { companyId_code: { companyId, code: rule.code } },
      create: {
        companyId,
        queueId: queue.id,
        code: rule.code,
        name: rule.name,
        source: rule.source,
        priority: rule.priority,
        conditionsJson: rule.conditionsJson,
        sortOrder: rule.sortOrder,
        isActive: true,
      },
      update: {
        queueId: queue.id,
        name: rule.name,
        source: rule.source,
        priority: rule.priority,
        conditionsJson: rule.conditionsJson,
        sortOrder: rule.sortOrder,
        isActive: true,
      },
    });
  }

  await prisma.supportAssignmentRule.updateMany({
    where: {
      companyId,
      code: { in: [...DISABLED_LEGACY_RULE_CODES] },
    },
    data: { isActive: false },
  });

  for (const policy of DEFAULT_SLA_POLICIES) {
    const queueId = policy.queueCode ? queuesByCode.get(policy.queueCode)?.id : null;
    if (policy.queueCode && !queueId) {
      throw new Error(`Queue ${policy.queueCode} was not created`);
    }
    await prisma.supportSlaPolicy.upsert({
      where: { companyId_code: { companyId, code: policy.code } },
      create: {
        companyId,
        queueId: queueId ?? null,
        code: policy.code,
        name: policy.name,
        priority: policy.priority,
        targetMinutes: policy.targetMinutes,
        warningMinutes: policy.warningMinutes,
        isActive: true,
      },
      update: {
        queueId: queueId ?? null,
        name: policy.name,
        priority: policy.priority,
        targetMinutes: policy.targetMinutes,
        warningMinutes: policy.warningMinutes,
        isActive: true,
      },
    });
  }

  console.log(
    `[support-bootstrap] done company=${companyId} queues=${DEFAULT_QUEUES.length} rules=${DEFAULT_RULES.length} slaPolicies=${DEFAULT_SLA_POLICIES.length}`,
  );
}

main()
  .catch((err) => {
    console.error("[support-bootstrap] failed", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
