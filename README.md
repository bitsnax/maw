# MAW — Managed Agent Wrapper

Next.js 16 + Prisma 7 + PostgreSQL 16 + Better Auth, served at
https://maw.lan.arpa with its own Traefik terminating TLS (step-ca ACME).
Lives at `/opt/maw` on the GPU box (192.168.4.201), a sibling of `/opt/docs`,
beside llama.cpp (`llama-cpp`, `192.168.4.201:8081`).

## Services (docker-compose.yml)

| Service | Container | Role |
|---|---|---|
| traefik | traefik-maw | TLS for maw.lan.arpa; no host ports; reached by the .201 edge over `proxy-nw` |
| migrate | maw-migrate | one-shot `prisma migrate deploy`, then exits; `web` waits for it |
| web | maw-web | Next.js standalone server on :3000 |
| postgres | maw-postgres | PostgreSQL 16; `127.0.0.1:5434` on the host only |
| opencode | maw-opencode | OpenCode 1.19.0 server (`opencode serve` on :4096, maw-net only); the 27B on llama.cpp; tools call back into maw-web |

Networks: `maw-net` (internal), `proxy-nw` (external, shared with the edge).
Volumes: `maw-pgdata`; `maw-opencode-data` (OpenCode's sessions, plugins,
provider packages); `maw-workspaces` (one stand-in folder per project,
shared by opencode, web and migrate).

## maw-agent (agent/)

The small TypeScript server MAW pairs with on each machine. It answers only
callers presenting MAW's client certificate (mutual TLS) and needs no
runtime dependencies. Built here, never run by this stack:

    docker compose --profile agent build agent          # image maw-agent:0.2.0 (tests run in the build)
    docker save maw-agent:0.2.0 | ssh 192.168.4.202 docker load

The agent runs with `pid: host` and `privileged` and mounts `/opt`: it
reads and writes project files itself, and runs commands on the host as
the machine's user (see Files and commands).

## Machines (admin only)

A machine is paired by running maw-agent on it; MAW then lists its
containers and can start, stop and restart them and read their logs.

- **Trust.** MAW has its own certificate authority (table `pki`, keys
  encrypted with `MAW_ENCRYPTION_KEY` — never change that value once a
  machine is paired). Each machine gets a certificate whose fingerprint MAW
  stores; its private key exists only in the machine's install file. MAW
  and the agent check each other on every call (mutual TLS, one fresh
  connection per call).
- **Add machine** (Machines → Add machine) shows the install file once.
  On the machine:

      docker save maw-agent:0.2.0 | ssh <address> docker load   # from .201, other machines only
      sudo mkdir -p /opt/maw-agent && sudo chown $(id -un) /opt/maw-agent
      # save the file as /opt/maw-agent/compose.yaml
      cd /opt/maw-agent && docker compose up -d

- **Reissue certificate** (machine page → Machine settings): new key and
  install file; the old file stops working at once. Replace the file on
  the machine and run `docker compose up -d --force-recreate`.
- **Remove machine**: typed confirmation; MAW stops accepting the agent and
  keeps its action history. Stop the agent on the machine with
  `cd /opt/maw-agent && docker compose down`.
- **Agent updates.** `AGENT_VERSION` in `web/lib/install-file.ts` is the
  version this MAW expects; a machine on an older agent shows "update
  available" (Machines list and machine page) with the two commands. Its
  certificate stays:

      docker save maw-agent:0.2.0 | ssh <address> docker load   # on .201; skip for .201 itself
      cd /opt/maw-agent && sed -i 's#image: maw-agent:[0-9.]*#image: maw-agent:0.2.0#' compose.yaml && docker compose up -d   # on the machine

  A new agent version: bump `agent/package.json`, the image tag in
  `docker-compose.yml` and `AGENT_VERSION` together.
- Every action sent to a machine is recorded (`machine_action`: who, when,
  what, result) and shown under Recent actions.

## Files and commands (agent 0.2.0)

MAW can work in a machine's project folders: read, list, write and edit
files, search them, and run commands. The machine page's **Console** tries
all of it by hand; OpenCode sessions (see Projects and sessions) use the
same calls through MAW's tool API.

- **Roots.** Every call names a project root, an existing folder inside
  `/opt` (the only host folder the agent mounts). Paths are resolved with
  links followed; anything outside the root is refused.
- **Files.** Read (numbered lines, 2,000 per call; binary files and files
  over 2 MB refused), list, write (new files belong to the machine's user,
  mode 664; an existing file keeps its owner and mode), edit (exact text,
  refused when not found or found more than once).
- **Search.** ripgrep in the agent image: text (regular expression) or file
  names (glob). What `.gitignore` excludes is skipped (node_modules, build
  output, `.env`); links are not followed.
- **Commands** run on the host as the machine's user, in a login shell
  (`nsenter … runuser -l <user>`), so its PATH (nvm, pyenv), git identity and
  SSH work as in a terminal; `umask 0002`, the host's `LANG`, started in the
  root. Output streams live (`/api/machines/<id>/exec/<job>`, admin only);
  what the login shell itself prints first is kept apart ("from the login
  shell"). Time limit 1 min to 1 h (default 10 min); Stop and the limit end
  the command and everything it started (TERM, then KILL after 5 s). At most
  4 at once per machine; the agent keeps a command's last 2,000 lines for 1
  hour after it ends (in memory: an agent restart forgets them).
- **Recorded** under Recent actions: every command (text, root, outcome:
  `exit 0 in 1.2 s`, `stopped after …`, `timed out after …`) and every
  write and edit (path). Reads, lists and searches are not recorded.
- Agent endpoints: `POST /v1/fs/{read,list,write,edit,glob,search}`,
  `POST /v1/exec`, `GET /v1/exec[/<id>[/stream]]`, `POST /v1/exec/<id>/stop`
  (see `agent/src/server.ts`).

## Projects and sessions (admin only)

A **project** is a folder on a paired machine, such as snax02 `/opt/caw`
(Projects → Add project; the folder must exist inside `/opt`). A
**session** is one OpenCode conversation with the 27B in a project: read
it, prompt it, watch it work, abort it.

- **Where things run.** OpenCode runs only in maw-opencode. Every file it
  reads, writes or searches and every command it runs happens on the
  project's machine, through maw-web and that machine's agent: MAW's six
  tools (`read`, `write`, `edit`, `glob`, `grep`, `bash`) replace OpenCode's
  built-ins and call `POST /api/tools/<tool>` on maw-web (Bearer
  `MAW_TOOLS_TOKEN`), which maps paths into the project root and calls the
  agent. Answers have OpenCode's own formats; bash output streams live.
- **Workspaces.** Each project has `/workspaces/<slug>` in maw-opencode
  (`<machine>-<folder>`, e.g. `snax02-caw`), a stand-in folder OpenCode
  works "in". When a session starts MAW writes its `AGENTS.md`: where the
  project really lives, plus the project's own `AGENTS.md` from the machine.
  Paths relative to the workspace, inside it, or inside the real root all
  map to the real root; anything else is refused.
- **No approvals.** Commands, writes and edits run straight away.
  `MAW_OPENCODE_BASH=ask` / `MAW_OPENCODE_EDIT=ask` in the opencode
  service's environment would turn OpenCode's approvals on, but MAW does
  not show approval requests yet.
- **Recorded.** Writes, edits and commands appear under the machine's Recent
  actions with the session's user as Who.
- **Session page** (`/projects/<id>/sessions/<sid>`): the conversation as it
  happens (OpenCode's events relayed by `/api/sessions/<sid>/events` as
  NDJSON): prompts, streamed answers, thinking (folded), tool rows with
  their output, questions the model asks (answer or dismiss), Abort, and a
  prompt box (a prompt sent while the model works runs after the turn).
  Under each finished turn: time, steps, context and output tokens.
- **Dashboard** (`/`): sessions working now (or waiting for an answer), what
  each is doing, updated every 5 s; recent sessions below. The Projects
  list and project page show each session's status.
- **Removing** a session deletes its conversation in OpenCode; removing a
  project removes its sessions. Files on the machine are never touched.

## maw-opencode (opencode/)

    docker compose build opencode       # image maw-opencode:1.19.0
    docker compose up -d opencode

- `write-config.mjs` writes `opencode.json` at every start from the
  service's environment (`docker-compose.yml`, values from `.env`):
  provider `llamacpp` (`@ai-sdk/openai-compatible`, `LLAMACPP_BASE_URL`,
  default `http://192.168.4.201:8081/v1`, key `LLAMACPP_API_KEY`), model
  `LLAMACPP_MODEL` (context 65536, output 16384), compaction (keep 24,000
  tokens, buffer 10,000), plugin `@tarquinen/opencode-dcp@3.2.0`
  (`MAW_OPENCODE_DCP=none` in the service's environment drops it), and snapshot, LSP, formatters,
  sharing, autoupdate, `apply_patch` and `websearch` off.
- `config/tools/*.ts` are MAW's six tools; their descriptions
  (`config/maw-lib/descriptions.json`) are OpenCode 1.19.0's, adjusted
  where MAW differs (fresh login shell per command; last 2,000 lines kept;
  no binary files).
- One llama.cpp slot (`N_PARALLEL=1`): MAW sessions, other OpenCode clients
  and CAW queue behind each other.
- **Mock model for tests.** `opencode/test/mock-llm.mjs` is an
  OpenAI-compatible stand-in that calls the tools on cue (`go`: all six;
  `sleep`: `sleep 30`; `slow`: a streamed answer; `ask`: a question). The
  step scripts run a test OpenCode (this image) against it and a temporary
  agent:

      docker compose run --rm --no-deps -e MAW_OPENCODE_URL=… -e MAW_OPENCODE_PASSWORD=… \
        migrate npx tsx scripts/opencode-selftest.ts mock <machine id> <root>

- **Checks against the real 27B:** `opencode-selftest.ts real <project>`
  (one read-only prompt; the session is kept), and
  `phase3-report.ts <project> [hours]` (what sessions in the project did:
  reads, searches, commands, edits, aborts, their records with Who, and
  `git diff --stat` on the machine).

## Routing

The .201 edge (`traefik-edge`, file `/opt/traefik-edge/dynamic.yml`) has
three `maw-*` routers (and their services): TCP `maw-https` passes `maw.lan.arpa` through to
`traefik-maw:443`; HTTP `maw-acme` sends ACME challenges to
`traefik-maw:80`; `maw-http` redirects plain HTTP to HTTPS. dnsmasq on .200
(`/opt/lan-dns/hosts/lan.hosts`) answers `maw.lan.arpa → 192.168.4.201`.

## Secrets (.env)

`.env` is gitignored; `.env.example` is the template. `web/.env` is a
symlink to `../.env` so host-side Prisma commands run from `web/` see it.

- `POSTGRES_PASSWORD` — letters and digits only (it is placed in
  `DATABASE_URL` without URL-encoding).
- `BETTER_AUTH_SECRET` — signs sessions; rotating it signs everyone out.
- `MAW_TOOLS_TOKEN` — shared by maw-web and maw-opencode for the tool API
  (at least 32 characters; `openssl rand -hex 32`).
- `MAW_OPENCODE_PASSWORD` — maw-web signs in to maw-opencode with it.
- `LLAMACPP_API_KEY` — llama.cpp's key (the llama-cpp container's
  `LLAMA_API_KEY`); recreate maw-opencode after changing it.

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
