# Carrier Routing Rules

Carrier routing rules decide which integration provider should execute an order leg.

They are separate from tariff plans:

```txt
Route template = ordered operational route skeleton
Tariff plan = what CargoPilot charges the customer
Carrier routing rule = which carrier/provider physically handles the route or exact leg
Integration provider = encrypted API credentials and endpoint for that carrier
```

## Why Route Templates Exist

Transit legs should not be duplicated independently in pricing and carrier setup.

The production setup should be:

```txt
Route template
  -> Tariff plan references routeTemplateId for pricing
  -> Carrier routing rules reference routeTemplateId / routeTemplateLegId for booking
  -> Order creation copies route template legs into OrderLeg rows
```

This lets the admin UI have one route builder and then attach price and carriers to that same route.

## Rule Matching

Rules are company-scoped and priority ordered. The highest priority active rule wins.

Supported matching fields:

- `companyId`
- `routeTemplateId`
- `routeTemplateLegId`
- `serviceType`
- `transportMode`
- `originCountryCode`
- `destinationCountryCode`
- `minWeightKg`
- `maxWeightKg`
- `legSequence`

If a field is empty, it means "match any".

Example:

```json
{
  "name": "CN to UZ Air Express - linehaul carrier",
  "companyId": "company-uuid",
  "providerId": "carrier-provider-uuid",
  "isActive": true,
  "priority": 100,
  "autoBook": true,
  "routeTemplateId": "route-template-uuid",
  "routeTemplateLegId": "route-template-leg-uuid",
  "serviceType": "DOOR_TO_DOOR",
  "transportMode": "air",
  "originCountryCode": "CN",
  "destinationCountryCode": "UZ"
}
```

## Auto Booking Flow

```txt
Order created
-> pricing selects tariff plan
-> tariff plan points to route template when configured
-> system creates OrderLeg rows from route template
-> routing resolver checks each not_requested leg
-> matching autoBook rule chooses providerId
-> carrier booking outbox command is created
-> integration worker sends request to carrier
-> carrier response/webhook updates OrderLeg and Tracking
```

Manual carrier booking remains useful for sandbox tests, overrides, and exception recovery.

## API

Route template APIs:

```txt
GET    /api/integrations/route-templates
GET    /api/integrations/route-templates/:id
POST   /api/integrations/route-templates
PATCH  /api/integrations/route-templates/:id
DELETE /api/integrations/route-templates/:id
```

Carrier routing APIs:

```txt
GET    /api/integrations/carrier-routing-rules
POST   /api/integrations/carrier-routing-rules
PATCH  /api/integrations/carrier-routing-rules/:id
DELETE /api/integrations/carrier-routing-rules/:id
```

Permissions:

```txt
integration.routing.read
integration.routing.manage
```

## Route Template Payload

```json
{
  "companyId": "company-uuid",
  "name": "CN to UZ Air via KZ",
  "code": "CN_UZ_AIR_KZ",
  "isActive": true,
  "priority": 200,
  "serviceType": "DOOR_TO_DOOR",
  "transportMode": "air",
  "originCountryCode": "CN",
  "destinationCountryCode": "UZ",
  "legs": [
    {
      "sequence": 1,
      "legCode": "cn_export",
      "label": "China export pickup",
      "mode": "road",
      "originCountryCode": "CN",
      "destinationCountryCode": "CN"
    },
    {
      "sequence": 2,
      "legCode": "cn_kz_air",
      "label": "China to Kazakhstan air linehaul",
      "mode": "air",
      "originCountryCode": "CN",
      "destinationCountryCode": "KZ"
    },
    {
      "sequence": 3,
      "legCode": "kz_uz_road",
      "label": "Kazakhstan to Uzbekistan road linehaul",
      "mode": "road",
      "originCountryCode": "KZ",
      "destinationCountryCode": "UZ"
    }
  ]
}
```

Validation rules:

- Leg sequence must be continuous and start from `1`.
- Leg codes must be unique inside the route template.
- First leg origin must match route `originCountryCode` when provided.
- Last leg destination must match route `destinationCountryCode` when provided.
- Consecutive legs must connect when both country codes are present.
- When editing an existing route, send each leg `id` back if that leg should keep the same identity. Carrier routing rules can point to `routeTemplateLegId`, so stable leg IDs prevent unnecessary rule rewiring.

## Tariff Plan Link

Tariff plans now accept:

```json
{
  "routeTemplateId": "route-template-uuid"
}
```

For `LEG_TRANSIT` pricing, the tariff still owns the money fields per leg:

```txt
ratePerKg
minCharge
flatFee
```

The route template owns the route structure:

```txt
sequence
legCode
mode
originCountryCode
destinationCountryCode
```

## Local Dev Stack

For normal backend development:

```powershell
npm run dev:stack
```

This starts:

- API server
- analytics outbox worker
- integration outbox worker
- order label worker

For carrier integration testing with the fake carrier:

```powershell
npm run dev:stack:fake
```

This adds the fake carrier server on `http://localhost:4100`.

Optional skips:

```powershell
$env:DEV_STACK_NO_ANALYTICS_OUTBOX="true"
$env:DEV_STACK_NO_INTEGRATION_OUTBOX="true"
$env:DEV_STACK_NO_LABELS="true"
```
