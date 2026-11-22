---
name: setup
description: Run initial CarapaBoard setup. Use when user wants to install Carapa from scratch on a new machine, install dependencies, authenticate WhatsApp, connect CarapaBrain objectives or CarapaMail, or start the background services. Triggers on "setup", "install", "configure carapa-board", "quick install", or first-time setup requests.
---

# Carapa Setup

Walks the user from a fresh PC to a working CarapaBoard demo: CarapaBox and CarapaBoard, plus optional CarapaWaLink (WhatsApp), CarapaBrain (objectives) and CarapaMail (mail security proxy). The heavy lifting (clone, build, start, write config) is in [scripts/quick-install.sh](scripts/quick-install.sh) — this skill drives it and handles the parts that need a human (agent CLI login, WhatsApp QR, Brain and Mail settings).

Run commands automatically. Only pause for steps that genuinely need user action (auth token paste, QR scan).

**Always use the `AskUserQuestion` tool for user choices** instead of writing the prompt as plain text.

The shared skills and rules are distributed from the separate
`carapa-agent-kit` repository (`https://github.com/carapa-ai/carapa-agent-kit`);
its `scripts/install.sh` installs them. Read
[references/agent-skills.md](references/agent-skills.md) when updating or syncing
that bundle; do not load every bundled skill as setup instructions.

## 1. Detect install state

Source previously-persisted state if it exists:

```bash
[ -f ~/.carapa/install.env ] && . ~/.carapa/install.env || true
INSTALL_DIR="${INSTALL_DIR:-$HOME/carapa}"
DEPLOY_DIR="${DEPLOY_DIR:-$HOME/.carapa/deploy}"
```

Then check what's running:

```bash
docker_running() { docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^$1$"; }
docker_running carapa-box   && BOX_UP=1   || BOX_UP=0
docker_running carapa-board && BOARD_UP=1 || BOARD_UP=0
[ -d "$INSTALL_DIR/carapa-board" ] && CLONED=1 || CLONED=0
```

Three branches:

- **Nothing installed** (`CLONED=0`): run quick-install.
- **Cloned, but `$DEPLOY_DIR/carapa-box/.env` or `$DEPLOY_DIR/carapa-board/.env` is missing**: an older installer deployed from the checkouts. Re-run quick-install (step 3); it moves both `.env` files into the deploy dir and redeploys from there.
- **Cloned but containers down**: `(cd "$DEPLOY_DIR/carapa-box" && docker compose up -d)` and same for `carapa-board`; then continue.
- **Already up** (`BOX_UP=1 && BOARD_UP=1`): skip to step 4.

### Deployment files

Box and Board are deployed from the operator-only deploy dir (default
`~/.carapa/deploy`, `--deploy-dir` to change it), never from their checkouts:

```
~/.carapa/deploy/
  carapa-box/    docker-compose.yml (copied from the checkout), .env,
                 config/ (mount allowlist, managed services, policies), state/, ingress/
  carapa-board/  docker-compose.yml (copied), docker-compose.override.yml, .env
  egress-proxy/  docker-compose.yml, .env, before-start.sh, squid.conf,
                 squid-entrypoint.sh, policy.rego (copied), tool_profiles.jsonc
  carapa-wa-link/ docker-compose.yml (generated), .env, store/ (WhatsApp session)
  carapa-mail/   docker-compose.yml (copied), docker-compose.override.yml, .env
  security/      seccomp and AppArmor profiles used by the deployed containers
```

Sandbox stacks live in the stacks dir (`$STACKS_DIR`, default
`~/carapa/my-stacks`): `carapa-bot/` (agent runtime; its `.harness/` records
the installed agent CLIs) and, with Brain, `carapa-brain/`. Secrets are in
`~/.carapa/secrets/{box,board,mail}`.

Compose trusts every file in the directory it runs in, and sandbox agents edit
the checkouts, so a deployment from a checkout would let a merged
`docker-compose.yml` or `.env` change grant itself host access. The copied
Compose files reach the checkout only through `CARAPA_BOX_SOURCE_DIR` /
`CARAPA_BOARD_SOURCE_DIR` / `EGRESS_SOURCE_DIR` (build contexts and read-only
source mounts; the egress relay code stays live from the checkout). CarapaBox
starts the egress proxy itself from `egress-proxy/` and runs its
`before-start.sh` there (`CARAPA_BOX_EGRESS_DEPLOY_DIR`). Keep the
deploy dir out of the mount allowlist and never mount it into a sandbox. Do not
`include`/`extends` checkout files from it. CarapaBox `restart_service` uses it
through `managed-services.yaml` (`composeDir` = deploy dir, `buildDir` =
checkout).

After pulling new versions, re-run quick-install: it refreshes the Compose
copies (keeping a `.bak-*` of each changed copy; review the diff), then rebuilds
and restarts. To rebuild one service by hand:

```bash
. ~/.carapa/install.env
(cd "$INSTALL_DIR/carapa-box" && CARAPA_BOX_DEPLOY_DIR="$DEPLOY_DIR/carapa-box" bash build.sh) \
  && (cd "$DEPLOY_DIR/carapa-box" && docker compose up -d carapa-box)
(cd "$INSTALL_DIR/carapa-board" && CARAPA_BOARD_DEPLOY_DIR="$DEPLOY_DIR/carapa-board" bash build.sh) \
  && (cd "$DEPLOY_DIR/carapa-board" && docker compose up -d --no-deps carapa-board)
```

## 2. Decide the machine's role and optional parts

First, unless the user already said so, ask what this machine is for:

- **CarapaBoard here** (a standalone installation, or this machine becomes the
  hub). Install CarapaBox and CarapaBoard as below.
- **A box for an existing CarapaBoard hub** (hub mode). Do not install Board
  here. Set up CarapaBox alone with its own setup skill, which ends by
  connecting the box to the hub (CarapaBox `docs/multi-host.md`, _Linux box_).
  Provider accounts and agents are then configured on the hub's Board, so stop
  this skill after that hand-off.

For a CarapaBoard installation, ask with one `AskUserQuestion` call holding three
questions:

1. (multiSelect) Which optional parts should we install? Board works without any of them.
   - **WhatsApp (carapa-wa-link)** (not published yet; the installer refuses `--with-whatsapp` unless your `--git-base` hosts it, so offer it only then) — chat with agents from WhatsApp; needs a QR scan with your phone in step 5.
   - **Objectives (carapa-brain)** (not published yet; the installer refuses `--with-brain` unless your `--git-base` hosts it, so offer it only then) — SMART goals that agents track and work towards; needs a one-time project setting in step 5b.
   - **Mail protection (carapa-mail)** — a filter between your mail app and your mail provider that quarantines dangerous mail and lets agents read or send mail; needs your mailbox details in step 5c.
2. (multiSelect) Which coding agents should run your Kanban tasks? — **Claude Code**, **Codex** (the seeded default), **Antigravity**, **Pi**, **OpenCode**, or others from the list below. Each needs its provider account connected later (step 8); [references/agent-runtimes.md](references/agent-runtimes.md) lists which account each one uses.
3. Automatic memory: should agents remember facts from past conversations, and which provider writes those memories? Off by default; each chat and task then makes extra model calls that count against the chosen account.
   - **Off (Recommended)** — agents still have the `memorize`/`recall` tools; nothing runs in the background, and DirectLLM's `/reflect` command is unavailable.
   - **ChatGPT sign-in** — the codex account from step 8, through Direct (`codex-relay`).
   - **Anthropic API key** — an `anthropic-api` account, through Direct.
   - **Local model** — Ollama or another OpenAI-compatible endpoint on this machine.

   The model itself is chosen in step 8b, once the account is connected.

Map the answers to `--with-whatsapp`, `--with-brain`, `--with-mail`, and
`--harnesses "<names> playwright"` with the names `codex`, `claude`,
`opencode`, `pi` (`playwright` backs the browser skill; it is tooling, not an
agent, so keep it and give it no catalog entry). Other valid names: `omp`,
`grok`, `cursor`, `prime-agent`, `hermes`, `antigravity`, `antigravity-acp`,
`muse`, `vibe`. Each chosen agent is set up end to end in step 8. Optional
parts installed by an earlier run stay installed and are updated on every
re-run.

## 3. Run the installer (if needed)

**Prerequisite:** carapa-box and the carapa-bot sandbox image pull from `dhi.io` (Docker Hardened Images). The user must be logged in to that registry, otherwise the build steps fail with "pull access denied":

```bash
docker login dhi.io
```

Free with any Docker Hub account. Verify with:

```bash
grep -q '"dhi.io"' "${DOCKER_CONFIG:-$HOME/.docker}/config.json" && echo "logged in" || echo "NOT logged in"
```

The installer will refuse to proceed without this — re-run it once login is set up. (Or pass `--skip-prereqs` if you've configured a credential helper that doesn't write to `config.json`.)

Other things the installer needs from the user's computer:

- **sudo** (the administrator password) on Linux hosts with AppArmor (Ubuntu, Debian): the installer loads the CarapaBox AppArmor profiles, security rules Docker applies to sandboxes, the egress proxy and Board's browser helper. Without them those containers refuse to start. The terminal asks for the password; tell the user before running. An agent's shell usually cannot answer that prompt: check `sudo -n true`, and if it fails, give the user the installer command to run in their own terminal (not with `!`, which has no TTY), piped to a log you can read (`2>&1 | tee ~/carapa-install.log`). Re-runs skip the AppArmor step while the profiles are unchanged, so you can run them yourself.
- **gVisor (`runsc`)** on Linux: the carapa-bot sandbox sets `runtime: runsc`. If Docker lacks that runtime, the installer stops before building and prints the command, `sudo bash ~/.carapa/deploy/security/install-gvisor.sh`. That command reloads the Docker daemon. Tell the user, let them run it, then re-run the installer.
- **A CVE scanner is optional.** With Trivy or Docker Scout installed, the sandbox image is scanned for known vulnerabilities after building; without one it is built unscanned and the installer prints a warning.
- Building the sandbox image and installing the agent CLIs downloads several GB and can take 10–30 minutes.
- **Existing checkouts.** For repositories already cloned in the install dir, the installer runs `git checkout <branch>` and `git pull --ff-only` (`--branch`, default `main`). Check their branches and uncommitted changes first, and ask the user before switching a development checkout.

The installer also prepares the parts Board's **Provider accounts** page needs (CarapaBox `docs/provider-accounts.md`): the credential directory `~/.carapa/provider-accounts` (mode 0700, outside every sandbox mount; an existing `PROVIDER_ACCOUNTS_DIR` is kept), the same path in Box's and the relay's `.env`, the relay-clients directory, the sign-in image and the harness volume. It also creates `squid-generated.conf` as a file and seeds the base network policy `config/policies/network-base.yaml`.

Run the installer (re-running is safe). Prefer a local script if this skill is invoked from a cloned `carapa-board`:

```bash
# FLAGS from step 2, e.g.: FLAGS=(--with-brain --with-mail --harnesses "codex claude playwright")
if [ -x "$(git rev-parse --show-toplevel 2>/dev/null)/.agent/skills/setup/scripts/quick-install.sh" ]; then
    bash "$(git rev-parse --show-toplevel)/.agent/skills/setup/scripts/quick-install.sh" "${FLAGS[@]}"
else
    bash <(curl -fsSL https://raw.githubusercontent.com/carapa-ai/carapa-board/main/.agent/skills/setup/scripts/quick-install.sh) "${FLAGS[@]}"
fi
```

If the script fails, surface the last 20 lines of its output and stop — don't continue blindly. Re-running is safe (idempotent).

After it succeeds, re-source state:

```bash
. ~/.carapa/install.env
```

## 4. First login

On its first start, CarapaBoard creates a single `admin` user with a random password and prints it once in its startup log. The installer shows it in its summary; to read it again before it is changed:

```bash
docker logs carapa-board 2>&1 | sed -n 's/^  password: //p' | tail -n1
```

- **Username:** `admin`
- **Password:** the generated password above

Tell the user:

> Open `https://localhost:$BOARD_HOST_PORT` in your browser. Accept the self-signed cert warning (one-time).
>
> On the sign-in screen:
>
> - Username: `admin`
> - Password: the generated password from the installer summary
>
> Change it after signing in. The browser you used is auto-approved as a trusted device on first login (since you're the lone admin). Any later sign-ins from a different browser/device land in an approval queue visible in the admin UI. Sign in first from the browser profile the operator will keep, not a private window: its device key is discarded on close and the auto-approval is not repeated (recovery: README, _4. Verify_).
>
> The board serves HTTPS from a local CA: import `$DATA_DIR/store/certs/ca.crt` (default `~/carapa/my-data/store/certs/ca.crt`) as a trusted **authority**, then reload. Firefox keeps its own store: Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import, and tick _Trust this CA to identify websites_. See `docs/tls-cert-trust.md`.

The Ubuntu Firefox snap cannot open files in hidden directories, so copy the CA
for the user first: `cp "$DATA_DIR/store/certs/ca.crt" ~/Downloads/carapa-board-ca.crt`.
If that file is missing, the board was started by an older image that issued a
self-signed certificate; follow _Browser shows "Not Secure"_ below.

## 5. WhatsApp QR (only with `--with-whatsapp`)

The QR is a terminal flow that needs Bun on the host:

```bash
cd "$INSTALL_DIR/carapa-wa-link" && STORE_DIR="$DEPLOY_DIR/carapa-wa-link/store" bun src/auth.ts
```

Tell the user:

> A QR code will appear. On your phone: **WhatsApp → Settings → Linked Devices → Link a Device**, then scan.

Wait for "Successfully authenticated". If it says "Already authenticated", continue. To re-auth, delete `$DEPLOY_DIR/carapa-wa-link/store/auth/` first.

After QR auth, restart the wa-link container so it picks up the credentials:

```bash
(cd "$DEPLOY_DIR/carapa-wa-link" && docker compose restart)
```

## 5b. Connect Objectives (only with `--with-brain`)

The installer built the Brain image, installed the `carapa-brain` sandbox stack
in `$STACKS_DIR/carapa-brain`, set `ENABLE_OBJECTIVES=true` for Board and
started the Brain sandbox (container `carapa-brain-main-agent-1`). If its
output said Brain did not start, show the user `docker logs carapa-brain-main-agent-1`
before continuing.

Board only sends events to Brain for projects that name it. Give the user the
token (`cat ~/.carapa/secrets/board/carapa_brain_auth_token`) and these clicks,
for each project that should use objectives (or once on a parent group, which
its projects inherit):

> 1. In Board, open the project, then the gear icon → **Project Settings**.
> 2. **General** tab → tick **Objectives** under modes.
> 3. **Integrations** tab → **Brain** section: **Brain Container** =
>    `carapa-brain-main-agent-1`; **Brain Auth Token** = the token above. Save.
>
> An **Objectives** view appears for the project.

Brain's curator and reflection steps use the models Board assigns in
`board_agents.jsonc` (`defaults.curator` / `defaults.reflector`, else
`defaults.chat`), so that model's provider account must be connected and its
harness set up (step 8). Brain has no local model setting for these steps.

## 5c. Connect a mailbox (only with `--with-mail`)

CarapaMail sits between the user's mail app and their mail provider: it
checks incoming mail, quarantines dangerous messages and lets agents read or
send mail for accounts the user allows. It started in rule-only mode, without
AI filtering, because no LLM key is configured.

Walk the user through it:

> 1. Open `http://localhost:3200/setup` and sign in with the admin token
>    (`cat ~/.carapa/secrets/mail/carapa_mail_token`).
> 2. Add your mail account. Enter your email address and choose a new
>    **CarapaMail password** (your mail app will use it). Under IMAP and SMTP
>    enter the server names, ports, user name and password your provider gives
>    for mail apps (often an "app password"). Click **Test Connection**.
> 3. To let agents use this mailbox: under **Permissions** turn on **MCP read**
>    (and **MCP send**, if agents may send mail), then click **Generate** in
>    the **MCP Token** section and copy the token; it is shown only once.
> 4. In Board → **Project Settings** → **Integrations** → **Carapa-Mail**:
>    enable it and paste the token as **Carapa-Mail Token**. Save.
> 5. In your mail app, use the hostname and ports shown on CarapaMail's
>    **mail client settings** card (IMAP `1993`, SMTP `2525` on this
>    computer) with your email address and the CarapaMail password.

To turn on AI filtering, put an Anthropic API key in
`~/.carapa/secrets/mail/anthropic_api_key`, set `AI_FEATURES_ENABLED=true` in
`~/.carapa/deploy/carapa-mail/.env` (for a local or other Anthropic-compatible
model also set `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` and
`FILTER_THINKING=disabled`), then run
`(cd ~/.carapa/deploy/carapa-mail && docker compose up -d)`.

## 6. Smoke test

```bash
. ~/.carapa/install.env

# -k tolerates the self-signed cert. The server serves HTTPS on the chosen
# host port and 301-redirects plaintext HTTP requests to the same URL via TLS.
echo "Board: $(curl -fsSk -o /dev/null -w '%{http_code}' https://localhost:$BOARD_HOST_PORT/ || echo down)"
echo "Box:   $(curl -fsS http://localhost:$BOX_HOST_PORT/health || echo down)"
[ "${WITH_MAIL:-}" = true ] && echo "Mail:  $(curl -fsS http://localhost:3200/health || echo down)"
[ "${WITH_BRAIN:-}" = true ] && echo "Brain: $(docker inspect -f '{{.State.Health.Status}}' carapa-brain-main-agent-1 2>/dev/null || echo down)"
python3 "$STACKS_DIR/carapa-bot/harness.py" status   # installed agent CLIs
```

Then print, for the user:

```
Board UI : https://localhost:$BOARD_HOST_PORT
           (self-signed cert — accept the browser warning on first visit)
```

If WhatsApp: tell them to send `@Capa hello` (or their trigger) in the registered chat.

## 7. Synchronize distributed agent skills

Run this for both new and existing installations, even when services were
already running. Quick-install also performs this step automatically.

The canonical shared skills and rules live in the `carapa-agent-kit` repository
that quick-install clones to `$INSTALL_DIR/carapa-agent-kit` (branch `main`). The
repository's `.agent/skills/` (also exposed as `.agents/skills/`) contains skills
for working on CarapaBoard itself; never copy that directory into the shared
agent home.

Resolve the host source mounted as `/home/ubuntu`: use the install state's
`AGENT_HOME_DIR`, or an explicitly configured `AGENT_HOME` for an existing custom
installation. Do not guess a default if neither is known.

```bash
[ -f ~/.carapa/install.env ] && . ~/.carapa/install.env
skill_agent_home="${AGENT_HOME:-${AGENT_HOME_DIR:-}}"
: "${skill_agent_home:?Resolve the configured agent-home mount source first}"
bash "$INSTALL_DIR/carapa-agent-kit/scripts/install.sh" --agent-home "$skill_agent_home"
bash "$INSTALL_DIR/carapa-agent-kit/scripts/install.sh" --agent-home "$skill_agent_home" --check
```

The command installs once into the real `.agent/skills` directory, with
`.claude/skills` and `.codex/skills` symlinked to `../.agent/skills` and `.agents`
symlinked to `.agent`. It also installs the kit's platform rules into `.agent/rules`
(linked as `.claude/rules`), leaving other rule files untouched, and the group and
objective templates into `.agent/scopes/{group,objective}`. It backs up migrated directories and changed prior
copies, and preserves unrelated skills and CLI credentials. Surface sync
failures before claiming setup is complete. Run it again after updating
distributed skill sources.
See [the distribution guide](references/agent-skills.md).

### Project apps that start with their sandbox

When setting up an app that should start whenever CarapaBox starts its sandbox,
add `.agent/after-start.sh` in the sandbox service's configured project checkout. Follow the
[app startup contract](https://github.com/carapa-ai/carapa-agent-kit/blob/main/platform/skills/playwright-cli/references/external-browser-access.md#start-apps-with-the-sandbox)
when configuring it: CarapaBox discovers this project-owned hook and runs it
inside the sandbox after each managed start. Project agents receive this guidance
through the distributed `project-setup` and `playwright-cli` skills. Ensure the
installed controller supports project startup hooks; no per-project edits to the
controller's stack `after-start.sh` are needed.

## 8. Set up the agents

An agent works only when four things line up: the harness is installed in
CarapaBox, its provider account is connected, the harness's own configuration
points at the relay (Codex, Pi, OMP, Prime, Hermes), and Board's catalog
(`$DATA_DIR/data/board_agents.jsonc`) has an entry for it. Credentials live
only with CarapaBox's relay: never log a CLI in inside the sandbox and never
copy host credentials (`~/.claude`, `~/.codex/auth.json`, ...) into the agent
home.

Read [references/agent-runtimes.md](references/agent-runtimes.md) and, for
**each** harness chosen in step 2, one at a time:

1. Confirm it is installed (`harness.py status`; install it otherwise).
2. Ask the user to connect its account in Board → **Provider accounts**, using
   the account type from the reference (a sign-in, or an API key Box checks).
   Do not ask for the secret in chat.
3. Apply the harness's own configuration from its recipe (for example Codex's
   `config.toml` in `$AGENT_HOME_DIR/.codex/`, or a Pi provider), showing the
   user what you write.
4. Add or update its catalog entry from the recipe, keeping existing entries,
   and set `defaults.chat` and `defaults.kanban.fallback` to the first harness
   that verifies. Check Board's log for `Invalid board_agents.jsonc`.
   When a harness should use another provider's account (a ChatGPT sign-in in
   Pi, OMP, Prime, Hermes or Direct; Claude models outside Claude Code), follow
   _Connections_ in the reference. Claude outside Claude Code needs an
   Anthropic API key, never the subscription sign-in.
5. Verify: the models appear in the picker and a new chat answers _Reply with
   OK_. Follow the reference's troubleshooting when it spins.

Recipes marked _from code_ have not been run end to end; tell the user, and
report what had to change. Finish by listing which harnesses were verified and
which were configured but not tested.

## 8b. Automatic memory (only if chosen in step 2)

Automatic transcript memory is off by default (`ENABLE_MEMORY_REFLECTOR`). When
it is on, Board's memory reflector calls `defaults.reflector` after chats and
tasks. `defaults.observer` is used only for History Review candidates in the
memory review. Both must select an HTTP-capable `direct` binding
(`docs/AGENTS-CONFIG.md`). Skip this step when the user chose **Off**.

1. Make sure the chosen provider works first: its account is connected
   (step 8) and, for a local model, the endpoint answers from the board
   container (`docker exec carapa-board bun -e "fetch('<baseUrl>/models').then(r => console.log(r.status))"`;
   the image has no `curl`).
2. Ask with `AskUserQuestion` which model writes the memories. Offer the
   provider's cheap, fast models first, marking one **(Recommended)**: for
   ChatGPT read the ids from `accounts.codex.models` in
   `$DATA_DIR/data/board_agents.discovered.json` (for example `gpt-6-luna`);
   for Anthropic a Haiku model; for a local endpoint the models it lists. Each
   chat and task adds observer and reflector calls, so a frontier model costs
   noticeably more.
3. Add the binding to `$DATA_DIR/data/board_agents.jsonc`, keeping existing
   entries: the `direct` harness (`{ "label": "Direct LLM", "kind": "direct" }`)
   if missing, the connection (`codex-relay` or `anthropic-api` from
   _Connections_ in [references/agent-runtimes.md](references/agent-runtimes.md),
   or `{ "baseUrl": "http://host.docker.internal:11434/v1" }` for Ollama), and a
   `models.<id>.bindings.direct` entry with that connection and model. Set
   `defaults.observer` and `defaults.reflector` to
   `{ "harnessId": "direct", "modelId": "<id>" }`. Optionally offer the same model for
   `defaults.commitMessage` (Git commit messages). Show the user what you write,
   then check Board's log for `Invalid board_agents.jsonc`.
4. Enable it: set `ENABLE_MEMORY_REFLECTOR=true` in
   `$DEPLOY_DIR/carapa-board/.env`, then
   `(cd "$DEPLOY_DIR/carapa-board" && docker compose up -d carapa-board)`.
5. Verify after the next chat turn: `docker logs carapa-board 2>&1 | grep -i reflector | tail`
   must show no `Connection error` or `401`. Tell the user how to turn it off
   again (`ENABLE_MEMORY_REFLECTOR=false`, same restart).

`defaults.peekFiles` also needs a `direct` binding; offer the same model if the
user wants file previews condensed.

## Uninstall

Removing an installation is a separate, explicit request; never use it to reset
a failed setup. Show the user the dry-run plan of
`.agent/skills/setup/scripts/uninstall.sh` (CarapaBoard README, _Uninstall_)
with the scopes they want, then apply with `--yes`. `--with-box` runs
CarapaBox's uninstaller with the same scopes. Give the user the printed `sudo`
commands (root-owned leftovers, `--host`) instead of running them.

## Troubleshooting

**Board unreachable on the chosen port** → `(cd "$DEPLOY_DIR/carapa-board" && docker compose logs --tail=80)`

**Browser shows "Not Secure" after importing the certificate, or there is no `ca.crt`** → the board issued a self-signed certificate (images built before the entrypoint created a local CA). From the checkout run `bash scripts/generate-certs.sh --force` (it finds the running board's store and keeps an existing CA), then `(cd "$DEPLOY_DIR/carapa-board" && docker compose restart carapa-board)` and import the new `ca.crt` as an authority (step 4). Check with `openssl s_client -connect localhost:$BOARD_HOST_PORT -CAfile "$DATA_DIR/store/certs/ca.crt" </dev/null | grep 'Verify return code'`; it should print `0 (ok)`.

**Provider accounts: "Provider account operation failed"** → CarapaBox has no credential directory: `PROVIDER_ACCOUNTS_DIR` is empty in `$DEPLOY_DIR/carapa-box/.env` or `$DEPLOY_DIR/egress-proxy/.env` (installs made before the installer set it). Re-run the installer, which sets it (step 3), then click **Retry**.

**Provider sign-in: "Login failed — cancel and retry"** → the sign-in reaches the provider through Squid. Check `docker ps | grep squid`: a `Restarting` container whose log ends in `FATAL: No HTTP, HTTPS, or FTP ports configured` mounted `$DEPLOY_DIR/carapa-box/state/squid-generated.conf` while it was missing, so Docker created a directory there. Replace it with an empty file (`rmdir` works without sudo when it is empty), remove the container and restart Box, which starts Squid again:

```bash
f="$DEPLOY_DIR/carapa-box/state/squid-generated.conf"
rmdir "$f" && touch "$f"
docker rm -f egress-proxy-squid-1 && docker restart carapa-box
```

Re-running the installer does the same repair. Also check Box's log for `PROVIDER_LOGIN_HARNESS_VOLUME` problems: it must name the volume `harness.py status` prints, with the provider's CLI installed. Then **Cancel login** and **Connect** again.

**Box logs `[NETWORK-POLICY] Reload failed: No network policy domains found` every minute** → `config/policies/network-base.yaml` is missing in Box's config dir. Copy `carapa-box/config/policies/network-base.example.yaml` to `$DEPLOY_DIR/carapa-box/config/policies/network-base.yaml`; Box reloads it within seconds (`Reload succeeded`).

**Agent runs fail with auth error, or a chat spins** → the relay has no credential for that harness's route: the wrong account type, an account not connected, or a box in hub mode. Follow _Verify each harness_ in [references/agent-runtimes.md](references/agent-runtimes.md).

**WhatsApp disconnected** → re-run the step 5 QR command (`STORE_DIR="$DEPLOY_DIR/carapa-wa-link/store" bun src/auth.ts` in `$INSTALL_DIR/carapa-wa-link`).

**Sandbox does not start: `No harness selection` or `Image changed`** → no agent CLIs are installed for the current image. Run `python3 "$STACKS_DIR/carapa-bot/harness.py" install codex` (or the CLIs chosen in step 2), then `python3 "$STACKS_DIR/carapa-bot/harness.py" check`.

**Sandbox does not start: `unknown or invalid runtime name: runsc`** → gVisor is not installed, or was removed by an uninstall with `--host`. Run `sudo bash ~/.carapa/deploy/security/install-gvisor.sh` (re-run the installer first if that file is missing), then start the project again. Do not switch the stack to `runc`.

**Container fails with `apparmor` / `profile not found`** → the CarapaBox AppArmor profiles are not loaded: `sudo bash ~/.carapa/deploy/security/install-apparmor.sh`, then retry.

**Box network missing (`board_walink` not found)** → `docker network create board_walink`, then re-run `docker compose up -d` in `$DEPLOY_DIR/carapa-board` and `$DEPLOY_DIR/carapa-wa-link`.

**Port conflict on re-run after a port the script chose got taken** → Stop the user's other process, or re-run with `--board-port`/`--box-port`/`--wa-port` and the script will rewrite the deploy dir's `.env` and override files.

**Operational note for agents:** Inside a sandbox container you typically cannot run `docker`, `pm2`, or `sqlite3`. In those cases, make the config change and tell the user which host command to run.
