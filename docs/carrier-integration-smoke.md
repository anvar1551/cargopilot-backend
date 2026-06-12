# Carrier Integration Smoke Test

This smoke test validates the local carrier integration flow without a real DHL/Aramex/FedEx contract.

It uses:

- CargoPilot API on `http://localhost:4000`
- Fake carrier API on `http://localhost:4100`
- Real integration provider config stored in the DB
- Real encrypted integration secret payload
- Real outbox dispatch and canonical event processing
- Real signed webhook ingestion and duplicate protection

## Flow

```txt
OrderLeg carrier booking
-> IntegrationOutbox pending row
-> fake carrier POST /shipments
-> outbound response canonical event
-> OrderLeg booked + tracking number saved
-> fake signed carrier webhook
-> webhook gateway HMAC verification
-> canonical carrier.status.updated event
-> OrderLeg in_transit + one tracking event
-> duplicate webhook ignored
```

## Required Running Services

Terminal 1:

```powershell
npm run dev
```

Terminal 2:

```powershell
npm run fake:carrier
```

Terminal 3:

```powershell
npm run test:integration:carrier
```

## Required Env

The API must already have normal backend env configured, including:

```txt
DATABASE_URL
JWT_SECRET
INTEGRATION_CONFIG_MASTER_KEY
```

The smoke runner needs:

```txt
INTEGRATION_ADMIN_EMAIL=anvar@cargopilot.com
INTEGRATION_ADMIN_PASSWORD=SuperPass123!
```

Optional overrides:

```txt
INTEGRATION_BASE_URL=http://localhost:4000
FAKE_CARRIER_BASE_URL=http://localhost:4100
FAKE_CARRIER_WEBHOOK_SECRET=dev_fake_carrier_secret
FAKE_CARRIER_PROVIDER_CODE=fake_carrier_fixed
CARRIER_SMOKE_COMPANY_ID=<uuid>
CARRIER_SMOKE_ORDER_ID=<uuid>
CARRIER_SMOKE_LEG_ID=<uuid>
```

If `FAKE_CARRIER_PROVIDER_CODE` is not set, the smoke runner creates a unique provider code per run. That keeps the carrier-booking idempotency key fresh and makes repeated smoke runs reliable against the same order leg.

If `CARRIER_SMOKE_COMPANY_ID` is not set, the script uses the company from the admin login response.

If `CARRIER_SMOKE_ORDER_ID` and `CARRIER_SMOKE_LEG_ID` are not set, the script selects the newest eligible order leg for that company. If auto-detection fails, create one order with at least one leg and pass the explicit IDs.

## What Success Means

The smoke test passes only when:

- The fake carrier provider is active and has encrypted config.
- Carrier booking returns `202`.
- The outbox dispatch marks the record as sent.
- The leg becomes `booked`.
- `carrierRef` and `carrierTrackingNumber` are saved.
- A signed carrier webhook is accepted.
- The duplicate webhook is returned as duplicate.
- The leg becomes `in_transit`.
- Only one tracking event is created for the duplicated webhook payload.

## Notes

The smoke runner calls `processIntegrationOutboxBatchOnce()` directly. That keeps local testing deterministic and avoids needing to run `npm run worker:integration-outbox` in a fourth terminal.
