# CargoPilot Backend

Backend API for CargoPilot.

## Prerequisites
- Node.js 22+
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
