# MAW — Managed Agent Wrapper

Next.js 16 + Prisma 7 + PostgreSQL 16 + Better Auth, served at
https://maw.lan.arpa with its own Traefik terminating TLS (step-ca ACME).
Lives at `/opt/maw` on the GPU box (192.168.4.201), a sibling of `/opt/docs`,
beside llama.cpp (`llama-cpp`, `192.168.4.201:8081`).

## Services (docker-compose.yml)

| Service | Container | Role |
|---|---|---|
| traefik | maw-traefik | TLS for maw.lan.arpa; no host ports; reached by the .201 edge over `proxy-nw` |
| migrate | maw-migrate | one-shot `prisma migrate deploy`, then exits; `web` waits for it |
| web | maw-web | Next.js standalone server on :3000 |
| postgres | maw-postgres | PostgreSQL 16; `127.0.0.1:5434` on the host only |

Networks: `maw-net` (internal), `proxy-nw` (external, shared with the edge).
Volume: `maw-pgdata`.

## Routing

The .201 edge (`traefik-edge`, file `/opt/traefik-edge/dynamic.yml`) has
three `maw-*` routers (and their services): TCP `maw-https` passes `maw.lan.arpa` through to
`maw-traefik:443`; HTTP `maw-acme` sends ACME challenges to
`maw-traefik:80`; `maw-http` redirects plain HTTP to HTTPS. dnsmasq on .200
(`/opt/lan-dns/hosts/lan.hosts`) answers `maw.lan.arpa → 192.168.4.201`.

## Secrets (.env)

`.env` is gitignored; `.env.example` is the template. `web/.env` is a
symlink to `../.env` so host-side Prisma commands run from `web/` see it.

- `POSTGRES_PASSWORD` — letters and digits only (it is placed in
  `DATABASE_URL` without URL-encoding).
- `BETTER_AUTH_SECRET` — signs sessions; rotating it signs everyone out.

## First run

    docker compose up -d --build
    docker compose logs migrate        # "All migrations have been successfully applied"
    docker compose run --rm \
      -e ADMIN_EMAIL=admin@maw.lan.arpa \
      -e ADMIN_PASSWORD='<10+ characters>' \
      migrate npx tsx scripts/create-admin.ts

Sign-up is disabled; the first admin is created by the script above, and
further users from Admin → Users.

## Schema changes

Every change to `web/prisma/schema.prisma` ships with its own migration
folder in the same commit. From `web/`, with the stack running:

    npx prisma migrate diff --from-config-datasource \
      --to-schema prisma/schema.prisma --script

prints the SQL the live database is missing; put it in
`prisma/migrations/<UTC yyyymmddHHMMSS>_<name>/migration.sql`
(`date -u +%Y%m%d%H%M%S`). Never edit an applied migration.
