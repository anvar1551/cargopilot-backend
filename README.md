# CargoPilot Backend

Backend API for CargoPilot.

## Prerequisites
- Node.js 22.12 or later within 22.x (Prisma 7 requirement; locally checked on 22.13.0)
- Package and lockfile root metadata declare `>=22.12.0 <23`. npm engines may
  warn rather than block unsupported installations; this is not a runtime guard.
  Docker/CI select Node 22 without a patch pin; built/deployed images are unverified.
  Use a currently supported patched 22.x release for deployment; 22.12 is a
  compatibility floor, not a recommended patch pin.
- Docker (optional, for containerized runs)

## Setup
1) Install dependencies:
   - `npm ci`
2) Create your environment file:
   - Copy `.env.example` to `.env` and fill in values
3) Run the app:
   - `npm run dev` (or your existing start script)

## Environment
All required variables are listed in [.env.example](.env.example).

## Notes
- Never commit `.env` or secret key files.
- Rotate any leaked secrets immediately.

## Architecture Policy
- Locked ERP backend policy: [docs/erp-architecture-policy.md](docs/erp-architecture-policy.md)
