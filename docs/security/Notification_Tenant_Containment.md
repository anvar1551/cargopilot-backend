# Notification tenant containment

## Enforced behavior in this slice

New `UserNotification` rows carry `tenantId`, `companyId` and
`companyMembershipId`. A presence check permits either a complete ownership
tuple or the fully null legacy state. Compound foreign keys prove that the
company belongs to the tenant, that the recipient owns the selected company
membership, and, when an order is present, that the order has the same tenant
and owner organization.

Tenant-facing list, detail, unread-count, single-read and read-all operations
reload the current selected membership and filter by recipient user, tenant,
company and company membership. Historical rows with null ownership fields do
not match these filters and remain inaccessible. Rejected single-read requests
use no update statement.

Order notification ownership comes from the stored order. The order must have a
tenant and owner organization, and the recipient must remain its assigned driver
with an active matching company membership and `drivers.telemetry`. Support
notification ownership comes from the stored ticket's owner organization. The
recipient must be its owner or configured queue owner and must have an active
matching membership with `support.update`. A producer that cannot prove these
relationships creates no notification.

Realtime unread-count delivery uses the same selected context and room as other
driver events. The event name and payload shape remain
`driver:notifications:unread-count` with `unreadCount` and `at`.

## Compatibility and remaining boundaries

Ownership columns remain nullable only to preserve existing rows during the
additive migration. No ownership is inferred from `userId`, and no historical
rows are backfilled. The migration must be applied before deploying this source.

Support tickets themselves do not yet carry an explicit tenant identifier. This
slice derives notification ownership through the ticket's tenant-owned
`ownerOrg`; tickets without that relationship cannot produce notifications.

No platform-global notification workflow is implemented. A future operational
requirement for platform notices needs a separately modeled recipient and
audience policy, rather than an exception to tenant-scoped queries.

Notification cleanup remains a platform maintenance operation over expiration
time and does not expose notification contents. Broader support-ticket tenant
constraints, proactive distributed socket revocation, and repository-wide
tenant cutover remain separate work.
