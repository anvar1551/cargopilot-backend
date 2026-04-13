#!/bin/sh
set -eu

mkdir -p /app/labels /app/invoices
chown -R appuser:nodejs /app/labels /app/invoices

if [ "${RUN_PRISMA_MIGRATIONS:-true}" = "true" ]; then
  gosu appuser npx prisma migrate deploy
fi

exec gosu appuser "$@"
