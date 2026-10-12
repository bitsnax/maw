ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# One-shot migrator: `prisma migrate deploy` against DATABASE_URL, then exit.
# Run by the `migrate` service in docker-compose.yml before `web` starts.
# Carries lib/ and scripts/ so one-off scripts (scripts/create-admin.ts)
# run here with `docker compose run --rm migrate npx tsx <script>`.
FROM dependencies AS migrate
COPY prisma.config.ts tsconfig.json ./
COPY prisma ./prisma
COPY lib ./lib
COPY scripts ./scripts
RUN npx prisma generate
CMD ["npx", "prisma", "migrate", "deploy"]

FROM node:${NODE_VERSION} AS builder
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
ENV NODE_ENV=production
ENV DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy"
RUN npm run build

FROM node:${NODE_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
COPY --from=builder --chown=node:node /app/public ./public
RUN mkdir .next && chown node:node .next
# Projects' workspace folders (volume maw-workspaces, shared with maw-opencode).
RUN mkdir -p /workspaces && chown node:node /workspaces
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
USER node
EXPOSE 3000
CMD ["node", "server.js"]
