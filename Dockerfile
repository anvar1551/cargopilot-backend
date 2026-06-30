FROM node:22-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates gosu && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci && npx prisma generate

FROM deps AS build
COPY package.json package-lock.json tsconfig.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
RUN NODE_OPTIONS=--max-old-space-size=3072 npm run build && npm prune --omit=dev && npm cache clean --force

FROM base AS prod
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000

RUN addgroup --system nodejs && adduser --system --ingroup nodejs appuser

COPY --chown=appuser:nodejs --from=build /app/package.json ./package.json
COPY --chown=appuser:nodejs --from=build /app/package-lock.json ./package-lock.json
COPY --chown=appuser:nodejs --from=build /app/prisma.config.ts ./prisma.config.ts
COPY --chown=appuser:nodejs --from=build /app/prisma ./prisma
COPY --chown=appuser:nodejs --from=build /app/node_modules ./node_modules
COPY --chown=appuser:nodejs --from=build /app/dist ./dist
COPY --chown=appuser:nodejs docker-entrypoint.sh ./docker-entrypoint.sh
RUN sed -i 's/\r$//' ./docker-entrypoint.sh && chmod +x ./docker-entrypoint.sh

EXPOSE 4000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/src/index.js"]
