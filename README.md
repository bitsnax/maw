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
| runner | maw-runner | MAW's loop that carries tasks forward, one model session at a time (`scripts/runner.ts`, the migrate image) |

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
- **Dashboard** (`/`) is the workspace where the work happens. A toolbar holds the
  project picker, the session picker (or "+ New session": the first prompt
  starts one, titled from the prompt), the project's command buttons, and
  Working · N s / Abort. Below it the output window shows the conversation as
  it happens (OpenCode's events relayed by `/api/sessions/<sid>/events` as
  NDJSON: prompts, streamed answers, thinking folded, tool rows with their
  output, questions to answer or dismiss, time and tokens per turn), with
  button runs in time order among the messages. The prompt box is sticky at
  the bottom; a prompt sent while the model works runs after the turn. The
  selection is kept in the address (`/?project=…&session=…`); "N active
  elsewhere" jumps to sessions working in other projects.
- **Command buttons** are set up on the project page (Add command: button
  title + command; `{name}` placeholders are asked for when pressed, each
  value one shell word). They show in the Dashboard toolbar for that project;
  a run happens in the project folder on its machine (never through
  OpenCode), is recorded under the machine's Recent actions with Who, and is
  kept with the session (`command_run`, last 500 lines) so it survives a
  reload.
- **Project page** (setup): command buttons, tasks, the sessions list
  (each opens on the Dashboard), the project profile, Remove project.
- **Tasks** (Phase 4): work too big for one model session (65,536
  tokens). You write a task on the project page (title, request, optional
  branch). MAW's agent breaks it into **phases** (task planning) and each
  phase into **steps** (phase planning), then works the steps; each planning
  pass and each step is its own session. Checklists (questions a planning
  pass answers, each checked in its own session; some marked for you to
  answer) and their findings belong to the task or to a phase. MAW's
  database is the record (`task`, `task_phase`, `task_step`,
  `task_item`, `task_finding`); nothing is written into the project for
  it. Pick a task in the Dashboard's second picker to follow it; its key
  (`1-tool-count`) and branch fill the buttons' `{task}` and `{branch}`.
  Download gives it as one markdown file for your records.
- **Task tools** (`opencode/config/tools/`, MAW side `web/lib/task-tools.ts`):
  the model in a session MAW runs for a task records its work through
  MAW's tool API like the file tools: `task_read` (task / phase N / step
  N.M as markdown), `item_add`, `finding_add`, `item_check`,
  `task_plan_set`, `phase_add`, `phase_plan_set`, `step_add`, `step_note`,
  `step_finish`. The session's `task_job` row (task, phase, step or item,
  kind) decides what the tools act on and which ones the session may use;
  other sessions get a plain refusal. In task sessions the bash tool
  refuses state-changing git (commit, checkout, branch, push, …) before
  anything runs; read-only git is fine.
- **Project profile** (project page, kept in MAW): the verify commands MAW
  runs after each step, the protected branches, and the profile text every
  task session is given.

## Tasks (admin only)

You write a **request** (what to build); MAW turns it into a **task** and
carries it through in short model sessions, because the work is too big for
one (llama.cpp's context is 65,536 tokens). The task is planned into
**phases**, each phase into **steps**, and each step is one session. Every
bit of state is in MAW's database: nothing is read from or written into the
project for this (no `plan/` folders, no handoff files). (The tables keep
their first names, `story_*`, behind Prisma's `@@map`; the code says task.)

    Request → Task ─ Phase ─ Step

- **You write it** on the project page (Tasks → New task): a title, the
  request (what to build, what is out of scope, when it is done) and the
  **branch**. MAW changes files only on that branch; you create it with your
  own command button. The branch is filled in from the title.
- **The project profile** (project page) holds what every task session is
  given: the profile text, the **verify commands** MAW runs after each step,
  the **deploy command** MAW runs to put the changes in front of you, and
  the **protected branches** MAW never changes files on.
- **maw-runner** does the rest, one session at a time across MAW (llama.cpp
  has one slot), and stops wherever you are needed. Its state is in the
  database, so restarting it is safe.

What MAW does, and where it stops for you:

| Stage | Sessions | Stops for you |
|---|---|---|
| Task planning | a checklist of what the plan needs, one session per item, then the task plan and its phases | items only you can answer; **Phases ready**: Approve phases or Plan again (with a direction) |
| Phase planning (one phase at a time) | **Plan steps** (with a direction, optional), the phase's checklist, one session per item, then the steps | items only you can answer; **Steps ready**: Approve steps or Plan again |
| Steps (in order) | one session per step; the model may edit files (no commits, no deploys); then MAW runs the verify commands, deploys when needed, and keeps git status and diff with the step; when the verify or the deploy fails, MAW runs the step again with the failing output (**2 repairs** at most) before it blocks | a step marked **Check**: Works as described / Doesn't work… (it runs again with your note); a **blocked** step: Try again (with a direction) or Mark done |
| Done | the last step of the last phase | commit, push and merge with your buttons |

- **Approvals** (per task: New task / Edit task, or the sidebar; applied
  within seconds): *You approve phases and steps* (the table above); *You
  approve phases; MAW approves steps* (MAW also starts each phase's
  planning, so no Plan steps); *MAW approves phases and steps*. With **Hold
  checks to the end of each phase**, a step marked Check does not stop the
  phase: MAW goes on, and once no other step is left to run, the phase's
  checks wait for you together (the last step deploys first). Items only
  you can answer, checks and blocks always stop.

- **Deploys are MAW's**, never the model's: after the verify commands pass,
  before any check, after a step the planner marked *deploy* (a schema
  change, a new route), and after a phase's last step. A failed deploy
  is repaired like a failed verify, then blocks the step with its output.
- **The branch check** runs before every step: on a protected branch, on
  another branch than the task's, or with no task branch, MAW waits and
  the Dashboard says why (the branch can be set right there).
- **In task sessions** the bash tool refuses git that changes state and
  docker commands that change what runs; planning sessions cannot write
  files at all.
- **Your directions and answers** go into every later session's prompt,
  marked as overriding the plan. A done step can be **reopened** with a
  note.
- **On the Dashboard** the left pane is the session MAW is working in
  (highlighted code, diffs, copy buttons) and the right sidebar is the task:
  its title opens your request, Plan opens the plan, each phase and step
  opens in a modal. The sidebar shows where it is ("Phase 1 of 2 · Step 1.2
  of 3"), what MAW is doing now, or **Needed from you** and what that is;
  every session MAW ran is listed under Sessions and opens in the output
  window. **Pause** stops the running session; Resume goes on from there.
  **Download** gives the whole task as markdown.
- **Sounds** (the bell in the toolbar, remembered per browser): `stopped`
  when a task or your session stops for you, `question` when you are asked
  something or a step needs your check, `error` when a task is blocked or a
  session fails, `finished` when a task is done. Browsers play sound only
  after one click on the page.

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
