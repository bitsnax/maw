ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS build
# ripgrep here too: the search tests run it.
RUN apk add --no-cache ripgrep
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
# The tests (root guard, host identity, files, search, commands) run here: a failure stops the build.
RUN npm run build && npm test

# Runtime: Node, the compiled agent, and ripgrep for project search.
# Runs as root inside the container: it needs the Docker socket and the
# host's namespaces (pid: host, privileged).
FROM node:${NODE_VERSION}
RUN apk add --no-cache ripgrep
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=build /app/dist ./dist
EXPOSE 7017
CMD ["node", "dist/server.js"]
