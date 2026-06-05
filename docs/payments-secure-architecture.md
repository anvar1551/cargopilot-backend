# Payments Secure Architecture (ERP RBAC Aligned)

Date: 2026-05-22
Owner: Backend (`orders-core`, `payments-core`, `identity-access`)

This document is the canonical secure path for payment flows and must follow `docs/erp-architecture-policy.md`.

## 1) Core principles

1. `orders-core` creates and manages orders.
2. `payments-core` owns provider config, payment intents, webhooks, and refund flows.
3. No hardcoded role logic or legacy auth bridge.
4. Payment finality comes from verified provider callback/webhook, never from client redirect alone.
5. Every sensitive operation is permission-gated, scope-checked, and auditable.

## 2) End-to-end payment flow

1. Create order first.
2. Backend computes payable amount server-side.
3. If order payment mode requires online payment, frontend opens payment step.
4. Frontend calls `POST /api/payments/intents` with:
   - `companyId`, `orderId`, `amountMinor`, `currency`, `provider?`, `idempotencyKey`
5. Backend resolves active provider config for company and creates intent.
6. If response contains `checkoutUrl`, frontend redirects user to provider checkout.
7. Provider callback/webhook hits backend endpoint.
8. Backend verifies signature/auth, applies idempotency/replay checks, updates intent state in transaction.
9. Order payment state is updated from intent status (`UNPAID/PENDING/PAID/FAILED`).

## 3) Payment mode decision rules

1. `paymentType = CASH` or `COD` -> no online intent at order creation.
2. `paymentType = CARD` / online transfer -> use payment-intent flow.
3. `paidBy` affects actor-facing flow:
   - `SENDER`: sender payment step
   - `RECIPIENT`: recipient link / handoff flow
   - `COMPANY`: invoice / postpaid flow

## 4) Provider config requirements

`PaymentProviderConfig` fields are provider-specific and validated strictly:

1. `CLICK`: `merchantId`, `serviceId`, `accountId` (`merchant_user_id`), `secret`
2. `PAYME`: `merchantId` (cashbox ID), `secret`; `accountId` optional
3. `UZUM`: `serviceId`, `accountId` (BasicAuth username), `secret`
4. `STRIPE`: `secret` = Stripe Secret Key (`sk_...`), `serviceId` = Stripe Webhook Secret (`whsec_...`)

Secrets are encrypted at rest and masked in responses.

## 5) RBAC + scope enforcement

Required permissions:

1. `payments.providers.read`
2. `payments.providers.manage`
3. `payments.intents.create`
4. `payments.intents.read`
5. `finance.refund` (when refund flow is implemented)

Access checks per request:

1. User authenticated
2. Membership active
3. Permission present
4. Company/resource in membership scope
5. Action executed
6. Audit event written

## 6) Webhook/callback security controls

1. Verify provider signature/auth before any state mutation.
2. Reject invalid payload/auth with clear error response.
3. Use unique idempotency key per provider+environment+event to block replay.
4. Process event + intent update in one DB transaction.
5. Never trust client-return URLs as payment proof.
6. Log sanitized metadata only (no secrets).

## 7) Idempotency guarantees

1. Client generates one `idempotencyKey` per payment attempt.
2. Retries must reuse same key.
3. Backend uniqueness (`companyId + idempotencyKey`) guarantees no duplicate intent.
4. New key means intentional new payment attempt.

## 8) Threat model checklist

1. Unauthorized provider config changes -> RBAC + scope + audit.
2. Credential leakage -> encrypted secret storage + masked read APIs.
3. Webhook forgery -> strict signature/auth verification.
4. Replay attacks -> idempotent webhook/event keys + unique constraints.
5. Amount tampering -> amount calculated/validated server-side.
6. Broken access isolation -> company scope filtering on every query.
7. Duplicate charge attempts -> intent idempotency.

## 9) Operational checklist before production

1. Enforce HTTPS everywhere.
2. Configure provider production credentials per company.
3. Configure callback URLs and IP/security allowlists if provider supports.
4. Enable rate limits for intent + callback routes.
5. Ensure `PAYMENT_CONFIG_MASTER_KEY` is set and rotated by policy.
6. Enable audit log retention and alerting on provider-config changes.
7. Run integration smoke tests for each enabled provider in test env before go-live.

## 10) Non-goals and current limitations

1. Refund adapter flows are not yet fully implemented for all providers.
2. Order->intent wiring must be completed in `orders-core` for unified live checkout.
