type SeedPermission = {
  key: string;
  resource: string;
  action: string;
  description: string;
};

function permission(
  key: string,
  resource: string,
  action: string,
  description: string,
): SeedPermission {
  return { key, resource, action, description };
}

export const SYSTEM_PERMISSIONS: SeedPermission[] = [
  permission("shipment.view", "orders", "read", "View shipments"),
  permission("shipment.create", "orders", "create", "Create shipments"),
  permission("shipment.update", "orders", "update", "Update shipments"),
  permission("shipment.delete", "orders", "delete", "Delete shipments"),
  permission("shipment.export", "orders", "export", "Export shipments"),
  permission("shipment.assignCourier", "orders", "assign", "Assign courier to shipment"),
  permission("shipment.bookCarrier", "orders", "assign", "Book shipment leg with carrier provider"),
  permission("shipment.changeStatus", "orders", "update", "Change shipment status"),
  permission("shipment.viewAssigned", "orders", "read", "View shipments assigned to actor"),

  permission("support.view", "support", "read", "View support tickets"),
  permission("support.createTicket", "support", "create", "Create support tickets"),
  permission("support.assign", "support", "assign", "Assign support tickets"),
  permission("support.update", "support", "update", "Update support tickets"),
  permission("support.escalate", "support", "manage", "Escalate support tickets"),
  permission("support.resolve", "support", "manage", "Resolve support tickets"),
  permission("support.configure", "support", "manage", "Configure support queues and assignment rules"),
  permission("notifications.read", "notifications", "read", "Read own notifications"),

  permission("pricing.read", "pricing", "read", "Read pricing configuration"),
  permission("pricing.write", "pricing", "update", "Write pricing configuration"),

  permission("customers.read", "customers", "read", "Read customer entities"),
  permission("customers.write", "customers", "update", "Write customer entities"),
  permission("organizations.read", "organizations", "read", "Read organizations directory"),
  permission("organizations.write", "organizations", "update", "Create and update organizations directory"),

  permission("drivers.read", "drivers", "read", "Read drivers"),
  permission("drivers.manage", "drivers", "manage", "Manage drivers"),
  permission("drivers.telemetry", "drivers", "telemetry", "Use driver telemetry features"),

  permission("warehouse.scanIn", "warehouses", "update", "Scan parcel into warehouse"),
  permission("warehouse.scanOut", "warehouses", "update", "Scan parcel out of warehouse"),
  permission("warehouse.transfer", "warehouses", "assign", "Transfer between warehouses"),

  permission("payments.providers.read", "payments", "read", "Read payment provider configs"),
  permission("payments.providers.manage", "payments", "manage", "Manage payment provider configs"),
  permission("payments.intents.create", "payments", "create", "Create payment intents"),
  permission("payments.intents.read", "payments", "read", "Read payment intents"),
  permission("finance.viewLedger", "payments", "read", "View finance ledger"),
  permission("finance.settleCash", "payments", "manage", "Settle operational cash"),
  permission("finance.refund", "payments", "manage", "Issue refunds"),
  permission("finance.settings.read", "finance", "read", "Read finance legal entity settings"),
  permission("finance.settings.manage", "finance", "manage", "Manage finance legal entity settings"),
  permission("finance.accounts.read", "finance", "read", "Read chart of accounts"),
  permission("finance.accounts.manage", "finance", "manage", "Manage chart of accounts"),
  permission("finance.postingRules.read", "finance", "read", "Read automatic finance posting rules"),
  permission("finance.postingRules.manage", "finance", "manage", "Manage versioned automatic finance posting rules"),
  permission("finance.periods.read", "finance", "read", "Read fiscal periods"),
  permission("finance.periods.manage", "finance", "manage", "Manage fiscal periods"),
  permission("finance.periods.close", "finance", "approve", "Restrict, close, and reopen fiscal periods"),
  permission("finance.journals.read", "finance", "read", "Read finance journals"),
  permission("finance.journals.create", "finance", "create", "Create draft finance journals"),
  permission("finance.journals.post", "finance", "approve", "Post balanced finance journals"),
  permission("finance.journals.reverse", "finance", "approve", "Reverse posted finance journals"),
  permission("finance.reports.read", "finance", "read", "Read finance statements and reports"),
  permission("finance.exceptions.read", "finance", "read", "Read automatic posting exceptions"),
  permission("finance.exceptions.manage", "finance", "manage", "Retry automatic posting exceptions"),
  permission("finance.invoices.read", "finance", "read", "Read customer invoices"),
  permission("finance.invoices.issue", "finance", "approve", "Issue customer invoices from priced orders"),
  permission("finance.receivables.read", "finance", "read", "Read customer receivables and aging"),
  permission("finance.settlements.read", "finance", "read", "Read provider settlement statements"),
  permission("finance.settlements.manage", "finance", "manage", "Import and submit provider settlements"),
  permission("finance.settlements.approve", "finance", "approve", "Approve or reject provider settlements"),
  permission("finance.payables.read", "finance", "read", "Read carrier supplier bills"),
  permission("finance.payables.manage", "finance", "manage", "Create and submit carrier supplier bills"),
  permission("finance.payables.approve", "finance", "approve", "Approve or reject carrier supplier bills"),
  permission("finance.treasury.read", "finance", "read", "Read bank accounts and supplier payment runs"),
  permission("finance.treasury.manage", "finance", "manage", "Manage bank accounts and prepare supplier payment runs"),
  permission("finance.treasury.approve", "finance", "approve", "Approve or reject supplier payment runs"),
  permission("finance.treasury.execute", "finance", "execute", "Execute approved supplier payment runs"),
  permission("finance.bankReconciliation.read", "finance", "read", "Read bank statements and reconciliation status"),
  permission("finance.bankReconciliation.manage", "finance", "manage", "Import and reconcile bank statements"),
  permission("finance.bankReconciliation.approve", "finance", "approve", "Approve or reject reconciled bank statements"),

  permission("membership.invite", "memberships", "create", "Invite company member"),
  permission("membership.suspend", "memberships", "manage", "Suspend company member"),
  permission("membership.restore", "memberships", "manage", "Restore company member"),
  permission("roles.read", "roles", "read", "Read role catalog"),
  permission("role.bindPermissions", "roles", "manage", "Bind permissions to role"),
  permission("session.revoke", "users", "manage", "Revoke user sessions"),
  permission("policy.override", "roles", "manage", "Use emergency policy override"),

  permission("integration.webhook.manage", "integrations", "manage", "Manage webhooks"),
  permission("integration.provider.read", "integrations", "read", "Read integration providers"),
  permission("integration.provider.manage", "integrations", "manage", "Manage integration providers"),
  permission("integration.provider.rotateSecret", "integrations", "manage", "Rotate provider secrets"),
  permission("integration.routing.read", "integrations", "read", "Read route templates and carrier routing rules"),
  permission("integration.routing.manage", "integrations", "manage", "Manage route templates and carrier routing rules"),
  permission("integration.outbox.read", "integrations", "read", "Read integration outbox and delivery attempts"),
  permission("integration.outbox.replay", "integrations", "manage", "Replay and retry integration outbox records"),
  permission("audit.read", "analytics", "read", "Read audit logs"),
];
