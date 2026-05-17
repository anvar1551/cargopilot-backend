# Payments Integration Quickstart (Click / Payme / Uzum)

This document gives copy-paste examples to test CargoPilot payment integrations quickly.

## 1) Prerequisites

- Backend running on `http://localhost:4000`
- Valid dashboard JWT token with payments permissions:
  - `payments.providers.manage`
  - `payments.providers.read`
  - `payments.intents.create`
  - `payments.intents.read`

Set env vars in your terminal:

```bash
export API_URL="http://localhost:4000/api"
export TOKEN="YOUR_JWT_TOKEN"
export COMPANY_ID="YOUR_ORG_UUID"
export ORDER_ID="YOUR_ORDER_UUID"
```

PowerShell:

```powershell
$env:API_URL="http://localhost:4000/api"
$env:TOKEN="YOUR_JWT_TOKEN"
$env:COMPANY_ID="YOUR_ORG_UUID"
$env:ORDER_ID="YOUR_ORDER_UUID"
```

---

## 2) Configure providers

## Click

```bash
curl -X POST "$API_URL/settings/payments/providers" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "companyId":"'"$COMPANY_ID"'",
    "provider":"CLICK",
    "environment":"TEST",
    "merchantId":"CLICK_MERCHANT_ID",
    "serviceId":"CLICK_SERVICE_ID",
    "secret":"CLICK_SECRET",
    "isEnabled":true
  }'
```

## Payme

```bash
curl -X POST "$API_URL/settings/payments/providers" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "companyId":"'"$COMPANY_ID"'",
    "provider":"PAYME",
    "environment":"TEST",
    "merchantId":"PAYME_MERCHANT_ID",
    "accountId":"order_id",
    "secret":"PAYME_SECRET",
    "isEnabled":true
  }'
```

## Uzum

```bash
curl -X POST "$API_URL/settings/payments/providers" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "companyId":"'"$COMPANY_ID"'",
    "provider":"UZUM",
    "environment":"TEST",
    "merchantId":"UZUM_MERCHANT_ID",
    "serviceId":"UZUM_SERVICE_ID",
    "accountId":"UZUM_API_USER",
    "secret":"UZUM_SECRET",
    "isEnabled":true
  }'
```

---

## 3) Create payment intent

Use same endpoint for all providers:

```bash
curl -X POST "$API_URL/payments/intents" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "companyId":"'"$COMPANY_ID"'",
    "orderId":"'"$ORDER_ID"'",
    "amountMinor":130000,
    "currency":"UZS",
    "provider":"CLICK",
    "idempotencyKey":"intent-demo-001"
  }'
```

`amountMinor` is always **minor units** in CargoPilot.
Examples:
- UZS: tiyin
- USD: cents

Provider conversion is handled server-side:
- Click -> numeric **major** amount sent to API
- Payme -> integer **minor** amount for checkout param `a`
- Uzum -> webhook-driven; intent stores expected minor amount for verification/audit

For Payme:
- change `"provider":"PAYME"`

For Uzum:
- change `"provider":"UZUM"`

Then fetch intent:

```bash
curl "$API_URL/payments/intents/INTENT_UUID_HERE" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 4) Webhook simulation

## 4.1 Click callback simulation

Click callback requires `sign_string = md5(click_trans_id + service_id + secret + merchant_trans_id + merchant_prepare_id_if_action_1 + amount + action + sign_time)`.

Example payload values:

- `click_trans_id=tx-1001`
- `service_id=CLICK_SERVICE_ID`
- `merchant_trans_id=INTENT_UUID`
- `merchant_prepare_id=INTENT_UUID`
- `amount=130000`
- `action=1`
- `sign_time=1715600000`
- `error=0`
- `error_note=Success`
- `click_paydoc_id=70001`

Send callback (replace `sign_string`):

```bash
curl -X POST "$API_URL/payments/click/callback" \
  -H "Content-Type: application/json" \
  -d '{
    "click_trans_id":"tx-1001",
    "service_id":"CLICK_SERVICE_ID",
    "merchant_trans_id":"INTENT_UUID",
    "merchant_prepare_id":"INTENT_UUID",
    "amount":"130000",
    "action":"1",
    "error":"0",
    "error_note":"Success",
    "sign_time":"1715600000",
    "sign_string":"REPLACE_WITH_MD5",
    "click_paydoc_id":"70001"
  }'
```

## 4.2 Payme callback simulation (JSON-RPC)

Auth header must be Basic and password must match provider secret.

```bash
PAYME_AUTH=$(printf "Paycom:PAYME_SECRET" | base64)

curl -X POST "$API_URL/payments/payme/callback" \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic $PAYME_AUTH" \
  -d '{
    "jsonrpc":"2.0",
    "id":"rpc-1001",
    "method":"PerformTransaction",
    "params":{
      "id":"payme-tx-1001",
      "account":{"order_id":"INTENT_UUID"}
    }
  }'
```

## 4.3 Uzum callback simulation

Auth header must be Basic:
- username: `accountId` (or merchantId)
- password: `secret`

```bash
UZUM_AUTH=$(printf "UZUM_API_USER:UZUM_SECRET" | base64)

curl -X POST "$API_URL/payments/uzum/callback" \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic $UZUM_AUTH" \
  -d '{
    "serviceId":"UZUM_SERVICE_ID",
    "transId":"uzum-tx-1001",
    "status":"CONFIRMED",
    "params":{"order_id":"INTENT_UUID"},
    "amount":130000
  }'
```

---

## 5) Verify final status

After callback, check:

```bash
curl "$API_URL/payments/intents/INTENT_UUID" \
  -H "Authorization: Bearer $TOKEN"
```

Expected:
- Click action=1 success -> `SUCCEEDED`
- Payme PerformTransaction -> `SUCCEEDED`
- Uzum status CONFIRMED -> `SUCCEEDED`

---

## 6) Security notes

- Never expose provider secrets in frontend.
- Secrets are encrypted server-side in `PaymentProviderConfig.secretEncrypted`.
- Webhook status changes are applied only after auth/signature verification.
- Always use unique idempotency keys for intent creation.
