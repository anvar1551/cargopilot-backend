#!/bin/sh
set -eu

if [ "${RUN_PRISMA_MIGRATIONS:-true}" = "true" ]; then
  npx prisma migrate deploy
fi

exec "$@"
