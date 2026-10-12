ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime: Node and the compiled agent only (no runtime dependencies).
# Runs as root inside the container: it needs the Docker socket now and,
# from Phase 2, the host's namespaces (pid: host, privileged).
FROM node:${NODE_VERSION}
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=build /app/dist ./dist
EXPOSE 7017
CMD ["node", "dist/server.js"]
