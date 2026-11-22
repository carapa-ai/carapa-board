#!/usr/bin/env bash
# quick-install.sh — Carapa demo installer.
#
# Brings up carapa-box (required) and carapa-board on a new machine, with
# carapa-wa-link, carapa-brain and carapa-mail as opt-ins. Idempotent: safe
# to re-run.
#
# Usage (remote one-liner):
#   curl -fsSL https://raw.githubusercontent.com/carapa-ai/carapa-board/main/.agent/skills/setup/scripts/quick-install.sh | bash
#
# Usage (with options):
#   bash quick-install.sh --with-whatsapp --board-port 4000
#
# Flags: see usage() below.

set -euo pipefail

SCRIPT_VERSION="1.0.0"
SCRIPT_NAME="$(basename "$0")"
TOTAL_STEPS=20
STEP_NUM=0

# ── Defaults ─────────────────────────────────────────────────────────────
INSTALL_DIR="${INSTALL_DIR:-$HOME/carapa}"
STACKS_DIR=""
DATA_DIR=""
AGENT_HOME_DIR=""
DEPLOY_DIR=""
GIT_BASE="${CARAPA_GIT_BASE:-https://github.com/carapa-ai}"
BRANCH="main"
WITH_WHATSAPP="false"
WITH_BRAIN="false"
WITH_MAIL="false"
# Agent CLIs installed into the sandbox harness volume. codex is the seeded
# Kanban default; playwright backs the distributed playwright-cli skill.
HARNESSES="codex playwright"
BOARD_PORT=""
BOX_PORT=""
WA_PORT=""
NON_INTERACTIVE="false"
SKIP_PREREQS="false"

SECRETS_BOX_DIR="$HOME/.carapa/secrets/box"
SECRETS_BOARD_DIR="$HOME/.carapa/secrets/board"
SECRETS_MAIL_DIR="$HOME/.carapa/secrets/mail"
INSTALL_STATE_FILE="$HOME/.carapa/install.env"

# ── Output helpers ───────────────────────────────────────────────────────
c_reset=$'\033[0m'
c_bold=$'\033[1m'
c_blue=$'\033[34m'
c_green=$'\033[32m'
c_yellow=$'\033[33m'
c_red=$'\033[31m'

step() {
    STEP_NUM=$((STEP_NUM + 1))
    echo
    echo "${c_blue}${c_bold}==> Step ${STEP_NUM}/${TOTAL_STEPS}: $1${c_reset}"
}

info()  { echo "    $1"; }
ok()    { echo "    ${c_green}✓${c_reset} $1"; }
warn()  { echo "    ${c_yellow}!${c_reset} $1"; }
fail()  { echo "    ${c_red}✗${c_reset} $1" >&2; }

on_error() {
    local exit_code=$?
    local line=$1
    echo
    fail "Install failed at step ${STEP_NUM}/${TOTAL_STEPS} (line ${line}, exit ${exit_code})."
    echo "    Re-run safely (idempotent), or open an issue:"
    echo "      ${GIT_BASE}/carapa-board/issues"
    exit "$exit_code"
}
trap 'on_error $LINENO' ERR

usage() {
    cat <<EOF
${SCRIPT_NAME} v${SCRIPT_VERSION} — Carapa demo installer

USAGE
    ${SCRIPT_NAME} [OPTIONS]

OPTIONS
    --install-dir <path>    Where to clone the repos. Default: \$HOME/carapa
    --stacks-dir <path>     Personal stacks dir (SANDBOX_STACKS_DIR). Default: <install-dir>/my-stacks
    --data-dir <path>       Carapa data dir (CARAPA_DATA_DIR). Default: <install-dir>/my-data
    --agent-home <path>     Sandbox /home/ubuntu mount. Default: <install-dir>/agent-home
                            (deliberately isolated from host \$HOME so egress-proxy
                            credential injection isn't bypassed)
    --deploy-dir <path>     Operator-only deployment dir (Compose files, .env,
                            Box config/state). Default: \$HOME/.carapa/deploy.
                            Must stay outside every sandbox-mountable path.
    --with-whatsapp         Also install carapa-wa-link (not published yet).
    --with-brain            Also install carapa-brain (SMART objectives) as a
                            CarapaBox sandbox stack (not published yet).
    --with-mail             Also install carapa-mail (SMTP/IMAP security proxy).
    --harnesses "<list>"    Agent CLIs to install in the sandbox, space-separated
                            (codex, claude, opencode, pi, grok, ...).
                            Default: "codex playwright"
    --git-base <url>        Clone base URL. Default: https://github.com/carapa-ai
                            (env: CARAPA_GIT_BASE)
    --branch <name>         Branch to clone. Default: main
    --board-port <n>        Host port for board UI. Default: first free >= 3000
    --box-port <n>          Host port for box API. Default: first free >= 3100
    --wa-port <n>           Host port for wa-link MCP. Default: first free >= 3467
    --non-interactive       Don't prompt for Claude auth; run skill or edit .env after.
    --skip-prereqs          Don't auto-install Docker/Bun or load AppArmor
                            profiles, and continue without a dhi.io login.
    --help                  Show this help.

EXAMPLES
    ${SCRIPT_NAME}
    ${SCRIPT_NAME} --with-whatsapp
    ${SCRIPT_NAME} --with-brain --with-mail --harnesses "codex claude playwright"
    ${SCRIPT_NAME} --install-dir /opt/carapa --board-port 4000
EOF
}

# ── Parse flags ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --install-dir)     INSTALL_DIR="$2"; shift 2 ;;
        --stacks-dir)      STACKS_DIR="$2"; shift 2 ;;
        --data-dir)        DATA_DIR="$2"; shift 2 ;;
        --agent-home)      AGENT_HOME_DIR="$2"; shift 2 ;;
        --deploy-dir)      DEPLOY_DIR="$2"; shift 2 ;;
        --with-whatsapp)   WITH_WHATSAPP="true"; shift ;;
        --with-brain)      WITH_BRAIN="true"; shift ;;
        --with-mail)       WITH_MAIL="true"; shift ;;
        --harnesses)       HARNESSES="$2"; shift 2 ;;
        --git-base)        GIT_BASE="$2"; shift 2 ;;
        --branch)          BRANCH="$2"; shift 2 ;;
        --board-port)      BOARD_PORT="$2"; shift 2 ;;
        --box-port)        BOX_PORT="$2"; shift 2 ;;
        --wa-port)         WA_PORT="$2"; shift 2 ;;
        --non-interactive) NON_INTERACTIVE="true"; shift ;;
        --skip-prereqs)    SKIP_PREREQS="true"; shift ;;
        --help|-h)         usage; exit 0 ;;
        *)                 fail "Unknown flag: $1"; usage; exit 2 ;;
    esac
done

INSTALL_DIR="${INSTALL_DIR/#\~/$HOME}"
STACKS_DIR="${STACKS_DIR:-$INSTALL_DIR/my-stacks}"
DATA_DIR="${DATA_DIR:-$INSTALL_DIR/my-data}"
AGENT_HOME_DIR="${AGENT_HOME_DIR:-$INSTALL_DIR/agent-home}"
DEPLOY_DIR="${DEPLOY_DIR:-$HOME/.carapa/deploy}"
STACKS_DIR="${STACKS_DIR/#\~/$HOME}"
DATA_DIR="${DATA_DIR/#\~/$HOME}"
DEPLOY_DIR="${DEPLOY_DIR/#\~/$HOME}"

# CarapaWaLink and CarapaBrain are not public yet. Refuse before any install
# step when a requested repo is not reachable at $GIT_BASE (a private
# $GIT_BASE that has them keeps working). Without git, require_cmd reports it.
require_published() {
    local repo=$1 name=$2 flag=$3
    command -v git >/dev/null 2>&1 || return 0
    if ! GIT_TERMINAL_PROMPT=0 git ls-remote --quiet "$GIT_BASE/$repo.git" HEAD >/dev/null 2>&1; then
        fail "$name is not published yet; rerun without $flag."
        exit 2
    fi
}
if [[ "$WITH_WHATSAPP" == "true" ]]; then require_published carapa-wa-link CarapaWaLink --with-whatsapp; fi
if [[ "$WITH_BRAIN" == "true" ]]; then require_published carapa-brain CarapaBrain --with-brain; fi

# ── Platform detection ───────────────────────────────────────────────────
detect_platform() {
    local kernel
    kernel="$(uname -s)"
    case "$kernel" in
        Linux)
            if grep -qiE "microsoft|wsl" /proc/version 2>/dev/null; then
                echo "wsl"
            else
                echo "linux"
            fi
            ;;
        Darwin)  echo "mac" ;;
        *)       echo "unknown" ;;
    esac
}
OS="$(detect_platform)"

if [[ "$OS" == "unknown" ]]; then
    fail "Unsupported OS: $(uname -s). Linux, WSL2, and macOS are supported."
    exit 1
fi

# Portable stat -- BSD (mac) uses -f, GNU (linux) uses -c.
stat_gid() {
    local path=$1
    if [[ "$OS" == "mac" ]]; then
        stat -f '%g' "$path" 2>/dev/null
    else
        stat -c '%g' "$path" 2>/dev/null
    fi
}

# ── Banner ───────────────────────────────────────────────────────────────
cat <<EOF
${c_bold}
   ▄▄▄·  ▄▄▄·  ▄▄▄·  ▄▄▄·  ▄▄▄· ▄▄▄·
  ▐█ ▀█ ▐█ ▀█ ▐█ ▀█ ▐█ ▀█ ▐█ ▀█ ▐█ ▀█
  ██    ▄█▀▀█ ▐█▀▀▄ ▄█▀▀█ ▐█▀▀  ▄█▀▀█
  ▐█  ▐ ▐█  ▐▌▐█  █▌▐█  ▐▌▐█    ▐█  ▐▌
   ▀▀▀   ▀  ▀  ▀   ▀ ▀  ▀  ▀     ▀  ▀
${c_reset}
  Carapa quick-install  v${SCRIPT_VERSION}

  platform    : ${OS}
  install dir : ${INSTALL_DIR}
  stacks dir  : ${STACKS_DIR}
  data dir    : ${DATA_DIR}
  agent home  : ${AGENT_HOME_DIR}
  deploy dir  : ${DEPLOY_DIR}
  branch      : ${BRANCH}
  whatsapp    : ${WITH_WHATSAPP}
  brain       : ${WITH_BRAIN}
  mail        : ${WITH_MAIL}
  harnesses   : ${HARNESSES}

EOF

# ── Helpers ──────────────────────────────────────────────────────────────

is_port_free() {
    local port=$1
    if command -v ss >/dev/null 2>&1; then
        if ss -ltn "sport = :${port}" 2>/dev/null | grep -q LISTEN; then
            return 1
        fi
    fi
    if command -v lsof >/dev/null 2>&1; then
        if lsof -iTCP:"${port}" -sTCP:LISTEN -P -n 2>/dev/null | grep -q .; then
            return 1
        fi
    fi
    return 0
}

pick_free_port() {
    local start=$1
    local p
    for p in $(seq "$start" $((start + 20))); do
        if is_port_free "$p"; then
            echo "$p"
            return 0
        fi
    done
    return 1
}

# Reuse a port from an existing dotenv (if set), else pick a free one
# starting at $2. Echoes the resolved port; returns non-zero only on probe failure.
resolve_port() {
    local existing=$1
    local default_start=$2
    local svc=$3
    if [[ -n "$existing" ]]; then
        if is_port_free "$existing" \
           || port_already_held_by_compose "$existing"; then
            echo "$existing"
            return 0
        fi
        fail "Port ${existing} for ${svc} is busy; pass --${svc}-port to override."
        return 1
    fi
    if ! pick_free_port "$default_start"; then
        fail "Could not find a free port for ${svc} in ${default_start}-$((default_start+20)). Pass --${svc}-port."
        return 1
    fi
}

# Best-effort check: is the listener on $1 actually a carapa container?
# Used to make re-runs idempotent (don't error if the existing carapa stack
# is already bound to its previously-chosen port).
port_already_held_by_compose() {
    local port=$1
    if ! command -v docker >/dev/null 2>&1; then return 1; fi
    docker ps --format '{{.Ports}} {{.Names}}' 2>/dev/null \
        | grep -E ":${port}->" \
        | grep -qE 'carapa-(board|box|wa-link)' || return 1
}

# Terminate a file's last line so an appended line cannot join it (some
# repository .env.example files end without a newline).
ensure_final_newline() {
    [[ -s "$1" && -n "$(tail -c 1 "$1")" ]] && echo >> "$1"
    return 0
}

# Insert or update a KEY=VALUE line in a dotenv-style file.
set_env_var() {
    local file=$1 key=$2 value=$3
    [[ -f "$file" ]] || touch "$file"
    if grep -qE "^${key}=" "$file"; then
        # Replace existing line; use awk to avoid sed escaping pain on paths.
        awk -v k="$key" -v v="$value" '
            BEGIN { found=0 }
            $0 ~ "^" k "=" { print k "=" v; found=1; next }
            { print }
            END { if (!found) print k "=" v }
        ' "$file" > "${file}.tmp"
        # Rewrite in place so the file keeps its mode (deploy .env files are 0600).
        cat "${file}.tmp" > "$file" && rm -f "${file}.tmp"
    else
        ensure_final_newline "$file"
        echo "${key}=${value}" >> "$file"
    fi
}

# Print a KEY's value from a dotenv-style file (empty when unset). Never sources it.
get_env_var() {
    local file=$1 key=$2
    [[ -f "$file" ]] || return 0
    awk -v k="$key" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2) } END { print v }' "$file"
}

# Move a .env written by an older installer out of its repository checkout,
# where sandbox agents can edit it, into the operator-only deploy dir. Seeds
# the destination from the repository example on a fresh install.
adopt_env() {
    local legacy=$1 dest=$2 example=$3
    if [[ ! -f "$dest" ]]; then
        if [[ -e "$legacy" ]]; then
            install -m 600 "$legacy" "$dest"
            rm -f "$legacy"
            ok "moved $legacy → $dest"
        elif [[ -f "$example" ]]; then
            install -m 600 "$example" "$dest"
        else
            install -m 600 /dev/null "$dest"
        fi
    elif [[ -e "$legacy" || -L "$legacy" ]]; then
        warn "$legacy is ignored; deployments read $dest"
    fi
    chmod 600 "$dest"
}

# Copy a repository deployment file (Compose file, hook, squid config) into
# the deploy dir. The copy is what runs, so later repository edits take effect
# only when the operator re-runs this installer; a changed copy is backed up
# for review.
DEPLOY_FILE_CHANGED="false"
install_deploy_file() {
    local src=$1 dest=$2 mode=${3:-644}
    if [[ -f "$dest" ]] && ! cmp -s "$src" "$dest"; then
        cp -p "$dest" "$dest.bak-$(date +%Y%m%d%H%M%S)"
        warn "updated $dest from the repository (previous copy kept as .bak-*; review with diff)"
    fi
    cmp -s "$src" "$dest" 2>/dev/null || DEPLOY_FILE_CHANGED="true"
    install -m "$mode" "$src" "$dest"
}

# Append a line to a file iff it isn't already present (anchored).
append_unique() {
    local file=$1 line=$2
    [[ -f "$file" ]] || touch "$file"
    grep -qxF "$line" "$file" || { ensure_final_newline "$file"; echo "$line" >> "$file"; }
}

# Generate a random hex secret into $1 if the file doesn't exist.
gen_secret() {
    local path=$1
    if [[ ! -f "$path" ]]; then
        mkdir -p "$(dirname "$path")"
        openssl rand -hex 32 > "$path"
        chmod 600 "$path"
        ok "generated $(basename "$path")"
    fi
}

# Wait up to ${2:-60}s for HTTP $1 to return 2xx/3xx.
wait_http() {
    local url=$1 timeout=${2:-60} elapsed=0
    # -k tolerates the self-signed cert that carapa-board's entrypoint
    # generates at /app/store/certs/server.{key,crt} on first boot.
    # --max-time 5 (not 2) — fresh TLS handshakes on slow/VM hosts can be
    # tight inside 2s.
    while [[ $elapsed -lt $timeout ]]; do
        if curl -fsSk --max-time 5 "$url" >/dev/null 2>&1; then
            return 0
        fi
        sleep 2
        elapsed=$((elapsed + 2))
    done
    return 1
}

# box_tool TOOL ARGS_JSON: call a CarapaBox MCP tool over its HTTP endpoint
# (initialize, initialized, tools/call in one session). Prints the response.
box_tool() {
    local tool=$1 args=$2 url="http://127.0.0.1:${BOX_HOST_PORT}/mcp" hdr sid auth
    auth="Authorization: Bearer $(cat "$SECRETS_BOX_DIR/carapa_box_api_token")"
    local -a h=(-H "$auth" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')
    hdr="$(mktemp)"
    curl -fsS -D "$hdr" -o /dev/null -X POST "$url" "${h[@]}" \
        -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"quick-install","version":"1"}}}' \
        || { rm -f "$hdr"; return 1; }
    sid="$(awk 'tolower($1) == "mcp-session-id:" { print $2 }' "$hdr" | tr -d '\r')"
    rm -f "$hdr"
    curl -fsS -o /dev/null -X POST "$url" "${h[@]}" -H "mcp-session-id: $sid" \
        -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' || return 1
    curl -fsS --max-time 900 -X POST "$url" "${h[@]}" -H "mcp-session-id: $sid" \
        -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}"
}

# clone_or_update REPO [BRANCH]: BRANCH defaults to $BRANCH. The agent kit has
# only `main`, so it passes that explicitly.
clone_or_update() {
    local repo=$1 branch="${2:-$BRANCH}" dest="$INSTALL_DIR/$1"
    if [[ -d "$dest/.git" ]]; then
        info "updating $repo (already cloned)"
        git -C "$dest" fetch --quiet origin
        git -C "$dest" checkout --quiet "$branch"
        git -C "$dest" pull --ff-only --quiet
    else
        info "cloning $repo"
        git clone --depth 1 -b "$branch" "$GIT_BASE/$repo.git" "$dest"
    fi
    ok "$repo ready"
}

# ── Step 1: Port resolution ──────────────────────────────────────────────
step "Resolve host ports"

# Reuse previously-chosen ports from install state, so the user's running
# stack doesn't get bounced to new ports on re-run.
prev_board="" prev_box="" prev_wa=""
if [[ -f "$INSTALL_STATE_FILE" ]]; then
    want_wa="$WITH_WHATSAPP" want_brain="$WITH_BRAIN" want_mail="$WITH_MAIL"
    # shellcheck disable=SC1090
    source "$INSTALL_STATE_FILE"
    prev_board="${BOARD_HOST_PORT:-}"
    prev_box="${BOX_HOST_PORT:-}"
    prev_wa="${WA_HOST_PORT:-}"
    # An optional part installed earlier stays installed and is updated on
    # re-runs; a flag adds it to an existing installation.
    if [[ "$want_wa" == "true" ]]; then WITH_WHATSAPP="true"; fi
    if [[ "$want_brain" == "true" || "${WITH_BRAIN:-}" == "true" ]]; then WITH_BRAIN="true"; else WITH_BRAIN="false"; fi
    if [[ "$want_mail" == "true" || "${WITH_MAIL:-}" == "true" ]]; then WITH_MAIL="true"; else WITH_MAIL="false"; fi
fi

BOARD_HOST_PORT="$(resolve_port "${BOARD_PORT:-$prev_board}" 3000 board)"
BOX_HOST_PORT="$(resolve_port "${BOX_PORT:-$prev_box}" 3100 box)"
if [[ "$WITH_WHATSAPP" == "true" ]]; then
    WA_HOST_PORT="$(resolve_port "${WA_PORT:-$prev_wa}" 3467 wa)"
else
    WA_HOST_PORT="${prev_wa:-3467}"
fi
ok "ports: board=${BOARD_HOST_PORT} box=${BOX_HOST_PORT} wa=${WA_HOST_PORT}"

# ── Step 2: Prereqs ──────────────────────────────────────────────────────
step "Check prerequisites"

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        fail "$1 is required but not installed."
        info "install via your package manager (apt/dnf/brew) and re-run."
        exit 1
    fi
}

require_cmd curl
require_cmd git
require_cmd python3
require_cmd openssl
require_cmd awk
require_cmd grep
require_cmd sed

# jq is optional — only used by the skill for parsing compose state.
command -v jq >/dev/null 2>&1 || warn "jq not found (optional; install for nicer status output)"

install_docker_engine() {
    info "installing Docker Engine via get.docker.com (requires sudo)"
    curl -fsSL https://get.docker.com | sh
    if ! groups | grep -q docker; then
        sudo usermod -aG docker "$USER"
        warn "added $USER to docker group — log out/in or run 'newgrp docker' before re-running"
        exit 1
    fi
    if [[ "$OS" == "wsl" ]]; then
        # WSL2 without systemd won't auto-start dockerd. Try to start it now.
        if ! pgrep -x dockerd >/dev/null 2>&1; then
            warn "WSL2 detected — dockerd may not auto-start without systemd."
            info "If you see 'cannot connect to the Docker daemon' below, run:"
            info "  sudo service docker start    # or enable systemd in /etc/wsl.conf"
            info "Alternative: Docker Desktop for Windows with WSL Integration also works"
            info "(untested with this script, but should — exposes the same /var/run/docker.sock)."
        fi
    fi
}

if command -v docker >/dev/null 2>&1; then
    # Existing Docker install — don't touch it. We don't probe what flavor
    # (Engine, Desktop, Colima, OrbStack, Rancher) — if it works for the
    # user, it works for us. Only condition: 'docker info' + compose plugin
    # must succeed below.
    ok "found existing docker at $(command -v docker) — using it as-is"
else
    case "$OS" in
        linux|wsl)
            if [[ "$SKIP_PREREQS" == "true" ]]; then
                fail "Docker missing and --skip-prereqs set. Install Docker manually."
                exit 1
            fi
            install_docker_engine
            ;;
        mac)
            # No clean auto-install path — every option on Mac runs Docker
            # inside a Linux VM. Listed in order of preference; Desktop last
            # because the maintainer hasn't tested it but it should work.
            fail "Docker not detected on macOS."
            info "Docker on Mac needs a Linux VM. Pick one:"
            info "  Colima         (open source, recommended):  brew install colima docker docker-compose && colima start"
            info "  OrbStack       (fast, paid):                brew install orbstack"
            info "  Rancher Desktop (open source):              https://rancherdesktop.io  (set runtime to dockerd/moby)"
            info "  Docker Desktop (untested with this script): https://www.docker.com/products/docker-desktop/"
            info "After install, ensure 'docker info' works in your shell, then re-run this script."
            exit 1
            ;;
    esac
fi

if ! docker info >/dev/null 2>&1; then
    fail "Docker is installed but not reachable as $USER."
    case "$OS" in
        linux) info "is the daemon running? in docker group? try: sudo service docker start; newgrp docker" ;;
        wsl)   info "WSL: try 'sudo service docker start' (or enable systemd in /etc/wsl.conf and restart WSL)" ;;
        mac)   info "if using Colima: 'colima start'  |  if OrbStack: open the app" ;;
    esac
    exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
    fail "Docker Compose plugin missing."
    info "install: https://docs.docker.com/compose/install/linux/"
    exit 1
fi
# The generated board override replaces the tracked port list with `!override`.
compose_version="$(docker compose version --short 2>/dev/null | sed 's/^v//')"
if [[ "$(printf '%s\n' 2.24.4 "$compose_version" | sort -V | head -n1)" != "2.24.4" ]]; then
    fail "Docker Compose ${compose_version:-unknown} is too old; 2.24.4 or newer is required."
    info "update: https://docs.docker.com/compose/install/linux/"
    exit 1
fi
ok "docker $(docker --version | awk '{print $3}' | tr -d ,) + compose ${compose_version}"

# carapa-box and the carapa-bot stack pull from Docker Hardened Images
# (dhi.io). Without a registry login, docker build fails with "pull access
# denied" at the FROM step. Check the user's docker config for an entry;
# this is best-effort — the config file path can vary, and Docker has
# multiple credential-helper backends — so we just warn rather than fail.
docker_config="${DOCKER_CONFIG:-$HOME/.docker}/config.json"
if [[ -f "$docker_config" ]] && grep -q '"dhi.io"' "$docker_config" 2>/dev/null; then
    ok "docker logged in to dhi.io"
else
    warn "no docker login for dhi.io detected — carapa-box and carapa-bot builds will fail."
    info "Run: docker login dhi.io   (uses your Docker Hub account; pull access is free)"
    info "Then re-run this script. See https://docs.docker.com/dhi/ for details."
    if [[ "$SKIP_PREREQS" != "true" ]]; then
        exit 1
    fi
fi

# The carapa-bot image build ends with a HIGH/CRITICAL CVE gate that needs
# Trivy or Docker Scout. Without either, build without the gate and say so.
if command -v trivy >/dev/null 2>&1 || docker scout version >/dev/null 2>&1; then
    BOT_SCAN_ARGS=()
    ok "CVE scanner found (images are scanned after building)"
else
    BOT_SCAN_ARGS=(--no-scan)
    warn "no CVE scanner (trivy or docker scout) — the sandbox image is built without its vulnerability scan."
    info "To scan: install Trivy (https://trivy.dev) and re-run this script."
fi

# Docker refuses to start a container whose AppArmor profile is not loaded.
# Sandboxes, the egress proxy and Board's browser helper use CarapaBox profiles.
APPARMOR_ENABLED="false"
if [[ "$OS" != "mac" ]] && [[ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)" == "Y" ]]; then
    APPARMOR_ENABLED="true"
    if [[ "$SKIP_PREREQS" != "true" ]] && ! command -v apparmor_parser >/dev/null 2>&1 \
       && [[ ! -x /sbin/apparmor_parser ]]; then
        fail "AppArmor is enabled but apparmor_parser is missing."
        info "install it (Debian/Ubuntu: sudo apt install apparmor) and re-run."
        exit 1
    fi
fi

if [[ "$WITH_WHATSAPP" == "true" ]] && ! command -v bun >/dev/null 2>&1; then
    if [[ "$SKIP_PREREQS" == "true" ]]; then
        warn "bun missing and --skip-prereqs set — wa-link QR auth won't run."
    else
        info "installing bun for wa-link QR auth"
        curl -fsSL https://bun.sh/install | bash >/dev/null
        # shellcheck disable=SC1091
        export PATH="$HOME/.bun/bin:$PATH"
        if ! command -v bun >/dev/null 2>&1; then
            warn "bun install completed but binary not in PATH — open a new shell before running WhatsApp QR auth"
        fi
    fi
fi

# The deploy dir must not be bind-mountable into a sandbox: Compose trusts
# every file in it, so an agent able to write there could grant itself host
# access on the next deploy.
deploy_real="$(realpath -m "$DEPLOY_DIR")"
for p in "$INSTALL_DIR" "$STACKS_DIR" "$DATA_DIR" "$AGENT_HOME_DIR" "$HOME/.ssh"; do
    p_real="$(realpath -m "$p")"
    if [[ "$deploy_real" == "$p_real" || "$deploy_real" == "$p_real"/* ]]; then
        fail "--deploy-dir $DEPLOY_DIR overlaps the sandbox-mountable path $p."
        info "Choose a deploy dir outside the install, stacks, data and agent-home dirs."
        exit 1
    fi
done
BOX_DEPLOY="$DEPLOY_DIR/carapa-box"
BOARD_DEPLOY="$DEPLOY_DIR/carapa-board"
SECURITY_DEPLOY="$DEPLOY_DIR/security"
EGRESS_DEPLOY="$DEPLOY_DIR/egress-proxy"
WA_DEPLOY="$DEPLOY_DIR/carapa-wa-link"
# The directory name is the Compose project name: carapa-mail-carapamail-1 is
# the container name Board and the relay expect.
MAIL_DEPLOY="$DEPLOY_DIR/carapa-mail"

# ── Step 3: Workspace setup ──────────────────────────────────────────────
step "Set up workspace"
mkdir -p "$INSTALL_DIR" \
         "$DATA_DIR"/data/ipc \
         "$DATA_DIR"/{groups,store,knowledge} \
         "$STACKS_DIR" \
         "$AGENT_HOME_DIR" \
         "$SECRETS_BOX_DIR" \
         "$SECRETS_BOARD_DIR" \
         "$BOX_DEPLOY" "$BOARD_DEPLOY" "$EGRESS_DEPLOY" "$SECURITY_DEPLOY" \
         "$(dirname "$INSTALL_STATE_FILE")"
chmod 700 "$SECRETS_BOX_DIR" "$SECRETS_BOARD_DIR" "$DEPLOY_DIR" "$BOX_DEPLOY" "$BOARD_DEPLOY" "$EGRESS_DEPLOY"
ok "workspace at $INSTALL_DIR, deployment files at $DEPLOY_DIR"

# ── Step 4: Clone repos ──────────────────────────────────────────────────
step "Clone repositories"
clone_or_update carapa-box
clone_or_update carapa-board
clone_or_update carapa-agent-kit main
if [[ "$WITH_WHATSAPP" == "true" ]]; then
    clone_or_update carapa-wa-link
fi
if [[ "$WITH_BRAIN" == "true" ]]; then
    clone_or_update carapa-brain
fi
if [[ "$WITH_MAIL" == "true" ]]; then
    clone_or_update carapa-mail
fi

# Stub for the gitnexus-hub bind mount referenced by carapa-board's compose.
# Compose refuses to start if the host path doesn't exist; an empty stub
# satisfies the read-only mount without needing the actual gitnexus-hub repo.
mkdir -p "$INSTALL_DIR/gitnexus-hub/.gitnexus"

# ── Step 5: Seed personal stacks ─────────────────────────────────────────
step "Seed personal stacks dir"
if [[ ! -d "$STACKS_DIR/carapa-bot" ]]; then
    if [[ -d "$INSTALL_DIR/carapa-box/stacks/carapa-bot" ]]; then
        cp -r "$INSTALL_DIR/carapa-box/stacks/carapa-bot" "$STACKS_DIR/carapa-bot"
        ok "copied carapa-bot to $STACKS_DIR"
    else
        warn "carapa-box/stacks/carapa-bot not found in clone — skipping stack seed"
    fi
else
    info "$STACKS_DIR/carapa-bot already exists — keeping user customizations"
fi

# Write the carapa-bot stack .env so the sandbox container has its own
# isolated /home/ubuntu (NOT the host $HOME — that would leak host
# ~/.claude credentials into the sandbox and bypass egress-proxy's auth
# injection). Shared skills are seeded after ownership repair below. Sandboxed
# CLIs (claude/codex/opencode) populate their own authentication state on first
# login from within the sandbox. SSH keys are a deliberate exception — git ops need real keys,
# so we share $HOME/.ssh read-only.
bot_stack_env="$STACKS_DIR/carapa-bot/.env"
if [[ ! -f "$bot_stack_env" ]] && [[ -f "$STACKS_DIR/carapa-bot/.env.example" ]]; then
    cp "$STACKS_DIR/carapa-bot/.env.example" "$bot_stack_env"
fi
set_env_var "$bot_stack_env" AGENT_HOME       "$AGENT_HOME_DIR"
set_env_var "$bot_stack_env" SSH_KEYS_FOLDER  "$HOME/.ssh"
ok "carapa-bot stack .env: AGENT_HOME=$AGENT_HOME_DIR (isolated from host \$HOME)"
if [[ ! -f "$STACKS_DIR/carapa-bot/harness.py" ]]; then
    fail "$STACKS_DIR/carapa-bot predates separately installed harnesses."
    info "Move it aside (keep your changes for reference) and re-run to seed the current stack."
    exit 1
fi
BOT_IMAGE="$(python3 "$STACKS_DIR/carapa-bot/harness.py" image)"

# CarapaBrain runs as a sandbox stack beside carapa-bot. Seed it before the
# carapa-box build, which compiles every stack's policy.
if [[ "$WITH_BRAIN" == "true" ]]; then
    brain_stack="$STACKS_DIR/carapa-brain"
    if [[ ! -d "$brain_stack" ]]; then
        cp -r "$INSTALL_DIR/carapa-brain/stack" "$brain_stack"
        ok "copied the carapa-brain stack to $STACKS_DIR"
    else
        info "$brain_stack already exists — keeping user customizations"
    fi
    [[ -f "$brain_stack/.env" ]] || install -m 600 "$brain_stack/.env.example" "$brain_stack/.env"
fi

# ── Step 6: Generate secrets ─────────────────────────────────────────────
step "Generate secrets"

# carapa-box secrets — these are read by egress-proxy.
gen_secret "$SECRETS_BOX_DIR/carapa_box_admin_token"
gen_secret "$SECRETS_BOX_DIR/carapa_box_api_token"

# carapa-board secrets — referenced as Docker secrets in its compose file.
# The compose blocks startup if any source file is missing, so even unused
# ones (neo4j_password, fcm-service-account.json) need at least a placeholder.
gen_secret "$SECRETS_BOARD_DIR/carapa_board_encryption_key"
gen_secret "$SECRETS_BOARD_DIR/postgres_password"
gen_secret "$SECRETS_BOARD_DIR/neo4j_password"

# Board needs to know the box's API token to talk to it — share the same value.
cp "$SECRETS_BOX_DIR/carapa_box_api_token" "$SECRETS_BOARD_DIR/carapa_box_api_token"
chmod 600 "$SECRETS_BOARD_DIR/carapa_box_api_token"

# WhatsApp token — generated either way; only used when WhatsApp is enabled.
gen_secret "$SECRETS_BOARD_DIR/carapa_wa_link_token"

# Board's browser helper: Board holds the token, the helper only its digest
# (of the token without its trailing newline).
gen_secret "$SECRETS_BOARD_DIR/web_browser_sidecar_token"
tr -d '\n' < "$SECRETS_BOARD_DIR/web_browser_sidecar_token" \
    | openssl dgst -sha256 -r | cut -d' ' -f1 > "$SECRETS_BOARD_DIR/web_browser_sidecar_token_sha256"
chmod 600 "$SECRETS_BOARD_DIR/web_browser_sidecar_token_sha256"

# CarapaBrain: Board sends this token (set in Project Settings); the Brain
# stack stores only its digest.
if [[ "$WITH_BRAIN" == "true" ]]; then
    gen_secret "$SECRETS_BOARD_DIR/carapa_brain_auth_token"
fi

# CarapaMail: admin login token, plus the files its Compose secrets need.
# An empty anthropic_api_key means no LLM is configured yet.
if [[ "$WITH_MAIL" == "true" ]]; then
    mkdir -p "$SECRETS_MAIL_DIR"
    chmod 700 "$SECRETS_MAIL_DIR"
    gen_secret "$SECRETS_MAIL_DIR/carapa_mail_token"
    gen_secret "$SECRETS_MAIL_DIR/carapa_mail_encryption_key"
    [[ -f "$SECRETS_MAIL_DIR/anthropic_api_key" ]] || install -m 600 /dev/null "$SECRETS_MAIL_DIR/anthropic_api_key"
fi

# fcm-service-account.json — push-notifications secret. Demo doesn't use it.
if [[ ! -f "$SECRETS_BOARD_DIR/fcm-service-account.json" ]]; then
    echo '{}' > "$SECRETS_BOARD_DIR/fcm-service-account.json"
    chmod 600 "$SECRETS_BOARD_DIR/fcm-service-account.json"
    ok "fcm-service-account.json placeholder"
fi

# ── Step 7: Configure carapa-box .env ────────────────────────────────────
step "Configure carapa-box .env"
box_env="$BOX_DEPLOY/.env"
# A fresh install also keeps Box's live config (mount allowlist, managed
# services, policies) and generated state private. An install created by an
# older version keeps its existing config/state locations; see
# carapa-box/docs/installation-data.md to migrate them.
box_fresh="false"
[[ -f "$box_env" || -e "$INSTALL_DIR/carapa-box/.env" ]] || box_fresh="true"
adopt_env "$INSTALL_DIR/carapa-box/.env" "$box_env" "$INSTALL_DIR/carapa-box/.env.example"

DOCKER_GID="$(stat_gid /var/run/docker.sock)"
DOCKER_GID="${DOCKER_GID:-999}"

set_env_var "$box_env" SANDBOX_HOST_DIR     "$INSTALL_DIR/carapa-box"
set_env_var "$box_env" SANDBOX_STACKS_DIR   "$STACKS_DIR"
set_env_var "$box_env" CARAPA_DATA_DIR      "$DATA_DIR"
# Shared with the board: both mount /app/ipc and /workspace/ipc out of this dir.
set_env_var "$box_env" IPC_MOUNT            "$DATA_DIR/data/ipc"
set_env_var "$box_env" DOCKER_GID           "$DOCKER_GID"
set_env_var "$box_env" SECRETS_DIR          "$SECRETS_BOX_DIR"
set_env_var "$box_env" SSH_KEYS_FOLDER      "$HOME/.ssh"
set_env_var "$box_env" MCP_SANDBOX_PORT     "$BOX_HOST_PORT"
set_env_var "$box_env" CARAPA_BOX_SOURCE_DIR  "$INSTALL_DIR/carapa-box"
set_env_var "$box_env" CARAPA_BOX_SECCOMP_DIR "$SECURITY_DEPLOY"
set_env_var "$box_env" CARAPA_BOX_ENV_FILE    "$box_env"
# The controller starts the egress proxy (and runs its before-start.sh) from here.
set_env_var "$box_env" CARAPA_BOX_EGRESS_DEPLOY_DIR "$EGRESS_DEPLOY"
# The deploy dir is private to the installing user; run the controller as
# that user so it can read its .env and config (Compose default is 1000:1000).
if [[ "$(id -u)" != "1000" ]] || [[ "$(id -g)" != "1000" ]]; then
    set_env_var "$box_env" BOX_UID "$(id -u)"
    set_env_var "$box_env" BOX_GID "$(id -g)"
fi
if [[ "$box_fresh" == "true" ]]; then
    # Create every bind source now: Docker would create missing ones as root.
    mkdir -p "$BOX_DEPLOY/config/policies" "$BOX_DEPLOY/state/groups" "$BOX_DEPLOY/state/nginx-routes" "$BOX_DEPLOY/ingress"
    chmod 700 "$BOX_DEPLOY/config" "$BOX_DEPLOY/config/policies" "$BOX_DEPLOY/state" "$BOX_DEPLOY/ingress"
    set_env_var "$box_env" CARAPA_BOX_HOME            "$BOX_DEPLOY"
    set_env_var "$box_env" CARAPA_BOX_CONFIG_HOST_DIR "$BOX_DEPLOY/config"
    set_env_var "$box_env" CARAPA_BOX_STATE_HOST_DIR  "$BOX_DEPLOY/state"
    set_env_var "$box_env" INGRESS_STATE_HOST_DIR     "$BOX_DEPLOY/ingress"
    set_env_var "$box_env" CARAPA_BOX_GROUPS_ROOT     "$BOX_DEPLOY/state/groups"
    set_env_var "$box_env" NGINX_PROXY_DIR            "$BOX_DEPLOY/state/nginx-routes"
fi
BOX_CONFIG_DIR="$(get_env_var "$box_env" CARAPA_BOX_CONFIG_HOST_DIR)"
BOX_CONFIG_DIR="${BOX_CONFIG_DIR:-$INSTALL_DIR/carapa-box/config}"
BOX_STATE_DIR="$(get_env_var "$box_env" CARAPA_BOX_STATE_HOST_DIR)"
if [[ "$BOX_CONFIG_DIR" == "$INSTALL_DIR/carapa-box/config" ]]; then
    warn "carapa-box config is still in the checkout ($BOX_CONFIG_DIR); see carapa-box/docs/installation-data.md to move it"
fi

# Squid bind-mounts squid-generated.conf as a file. Missing, Docker creates it
# as a root-owned directory, squid reads that as a config without ports and
# restart-loops ("No HTTP, HTTPS, or FTP ports configured"), so every egress
# (provider sign-in included) fails. Empty means "use the squid.conf template".
squid_generated="${BOX_STATE_DIR:-$INSTALL_DIR/carapa-box/generated}/squid-generated.conf"
mkdir -p "$(dirname "$squid_generated")"
if [[ -d "$squid_generated" ]]; then
    # Left by an earlier run; empty, and its parent is ours, so no sudo needed.
    if rmdir "$squid_generated" 2>/dev/null; then
        info "replaced the directory Docker created at $squid_generated with a file"
    else
        fail "$squid_generated is a non-empty directory; squid needs a file there."
        info "Remove it, then re-run: sudo rm -rf $squid_generated"
        exit 1
    fi
fi
[[ -e "$squid_generated" ]] || : > "$squid_generated"

# Base network policy. Without it Box cannot generate the squid config and
# logs "[NETWORK-POLICY] Reload failed: No network policy domains found"
# every minute. Existing policies are kept.
network_base="$BOX_CONFIG_DIR/policies/network-base.yaml"
if [[ ! -f "$network_base" ]]; then
    mkdir -p "$(dirname "$network_base")"
    cp "$INSTALL_DIR/carapa-box/config/policies/network-base.example.yaml" "$network_base"
    ok "seeded base network policy ($network_base)"
fi

# Provider accounts (Board → Provider accounts). Box and the relay share this
# credential directory; it must stay outside every sandbox mount
# (carapa-box/docs/provider-accounts.md). Unset, the page only shows
# "Provider account operation failed". A configured path is kept.
PROVIDER_ACCOUNTS_HOST_DIR="$(get_env_var "$box_env" PROVIDER_ACCOUNTS_DIR)"
PROVIDER_ACCOUNTS_HOST_DIR="${PROVIDER_ACCOUNTS_HOST_DIR:-$HOME/.carapa/provider-accounts}"
pa_real="$(realpath -m "$PROVIDER_ACCOUNTS_HOST_DIR")"
for p in "$INSTALL_DIR" "$STACKS_DIR" "$DATA_DIR" "$AGENT_HOME_DIR" "$HOME/.ssh"; do
    p_real="$(realpath -m "$p")"
    if [[ "$pa_real" == "$p_real" || "$pa_real" == "$p_real"/* ]]; then
        fail "PROVIDER_ACCOUNTS_DIR $PROVIDER_ACCOUNTS_HOST_DIR overlaps the sandbox-mountable path $p."
        info "Set PROVIDER_ACCOUNTS_DIR in $box_env to a directory outside it, then re-run."
        exit 1
    fi
done
install -d -m 700 "$PROVIDER_ACCOUNTS_HOST_DIR"
set_env_var "$box_env" PROVIDER_ACCOUNTS_DIR "$PROVIDER_ACCOUNTS_HOST_DIR"
# The sign-in worker runs the sandbox image built in step 14.
set_env_var "$box_env" PROVIDER_LOGIN_IMAGE "$BOT_IMAGE"
ok "carapa-box .env written ($box_env)"

# ── Step 8: Configure egress-proxy .env ──────────────────────────────────
step "Configure egress-proxy .env"
egress_env="$EGRESS_DEPLOY/.env"
adopt_env "$INSTALL_DIR/carapa-box/egress-proxy/.env" "$egress_env" "$INSTALL_DIR/carapa-box/egress-proxy/.env.example"
set_env_var "$egress_env" SECRETS_DIR "$SECRETS_BOX_DIR"
# Host paths: service code and image build contexts stay in the checkout;
# compose, hook and squid files come from the deploy dir.
set_env_var "$egress_env" EGRESS_SOURCE_DIR "$INSTALL_DIR/carapa-box/egress-proxy"
set_env_var "$egress_env" EGRESS_CONFIG_DIR "$EGRESS_DEPLOY"
# Squid mounts the controller's generated config from the same state dir
# (the checkout's generated/ for installs that kept their legacy state).
set_env_var "$egress_env" CARAPA_BOX_STATE_HOST_DIR "${BOX_STATE_DIR:-$INSTALL_DIR/carapa-box/generated}"
# The relay shares the egress_proxy network with Board and reaches it by service
# name on the container port (the published port is loopback-only by default,
# which the host gateway cannot reach); Board serves HTTPS there.
set_env_var "$egress_env" CARAPA_BOARD_HOST     "carapa-board"
set_env_var "$egress_env" CARAPA_BOARD_PORT     "3000"
set_env_var "$egress_env" CARAPA_BOARD_PROTOCOL "https"
# The relay reads and refreshes the credentials Box stores for provider accounts.
set_env_var "$egress_env" PROVIDER_ACCOUNTS_DIR "$PROVIDER_ACCOUNTS_HOST_DIR"
# Box reads the relay's client list; both must resolve to the same directory.
relay_clients_parent="$(get_env_var "$egress_env" RELAY_CLIENTS_DIR)"
set_env_var "$box_env" PROVIDER_RELAY_CLIENTS_DIR \
    "${relay_clients_parent:-$INSTALL_DIR/carapa-box/egress-proxy}/relay-clients"
ok "egress-proxy .env written ($egress_env)"

# ── Step 9: Mount allowlist ──────────────────────────────────────────────
step "Configure mount allowlist"
allowlist="$BOX_CONFIG_DIR/mount-allowlist.yaml"
allowlist_example="$INSTALL_DIR/carapa-box/config/mount-allowlist.example.yaml"
mkdir -p "$(dirname "$allowlist")"
if [[ ! -f "$allowlist" ]]; then
    if [[ -f "$allowlist_example" ]]; then
        # Start from a clean header — the example file has placeholder paths
        # we don't want carried over.
        cat > "$allowlist" <<EOF
# Host directories allowed as bind-mount sources.
# Generated by quick-install.sh; edit to add more paths.
allowed:
EOF
    else
        echo "allowed:" > "$allowlist"
    fi
fi

# Each unique line gets added once. $HOME/.ssh is whitelisted so the
# sandbox can do git ops with real keys; the agent-home dir is whitelisted
# so the carapa-bot stack can bind-mount it as /home/ubuntu. $HOME itself
# is NOT whitelisted on purpose — keeps host CLI auth out of the sandbox.
for p in "$INSTALL_DIR" "$STACKS_DIR" "$DATA_DIR" "$AGENT_HOME_DIR" "$HOME/.ssh"; do
    append_unique "$allowlist" "  - $p"
done
ok "allowlist: $INSTALL_DIR, $STACKS_DIR, $DATA_DIR, $AGENT_HOME_DIR, $HOME/.ssh"

# ── Step 10: Configure carapa-board .env ─────────────────────────────────
step "Configure carapa-board .env"
board_env="$BOARD_DEPLOY/.env"
adopt_env "$INSTALL_DIR/carapa-board/.env" "$board_env" "$INSTALL_DIR/carapa-board/.env.example"
set_env_var "$board_env" CARAPA_BOARD_SOURCE_DIR      "$INSTALL_DIR/carapa-board"
set_env_var "$board_env" CARAPA_BOARD_SECCOMP_PROFILE "$SECURITY_DEPLOY/seccomp-web.json"
set_env_var "$board_env" WEB_BROWSER_SECCOMP_PROFILE  "$SECURITY_DEPLOY/seccomp-default.json"
set_env_var "$board_env" API_PORT             "3000"
set_env_var "$board_env" SECRETS_DIR          "$SECRETS_BOARD_DIR"
set_env_var "$board_env" CARAPA_DATA_DIR      "$DATA_DIR"
set_env_var "$board_env" CARAPA_BOX_URL       "http://host.docker.internal:${BOX_HOST_PORT}"
# The browser helper reuses the sandbox runtime image (Chromium + Bun).
set_env_var "$board_env" WEB_BROWSER_IMAGE    "$BOT_IMAGE"
if [[ "$WITH_BRAIN" == "true" ]]; then
    set_env_var "$board_env" ENABLE_OBJECTIVES "true"
fi

# Disabled by default — GitNexus needs the gitnexus-hub service running and
# repos indexed before it adds value. Demo installs don't have either, and
# leaving it on means every board startup logs noisy connection errors. Flip
# to true after you've set up gitnexus-hub.
set_env_var "$board_env" ENABLE_GITNEXUS      "false"

# Run the board container as the installing user so bind-mounted dirs
# (store/, groups/, data/) end up owned by the host user, not UID 1000.
# Compose default is 1000:1000 — skip writing if that's already the host UID/GID.
HOST_UID=$(id -u)
HOST_GID=$(id -g)
if [[ "$HOST_UID" != "1000" ]] || [[ "$HOST_GID" != "1000" ]]; then
    set_env_var "$board_env" RELAY_UID "$HOST_UID"
    set_env_var "$board_env" RELAY_GID "$HOST_GID"
    info "set RELAY_UID=$HOST_UID RELAY_GID=$HOST_GID (host user is not 1000:1000)"
fi

# Always fix ownership on data + agent-home + stacks. Docker auto-creates any
# missing bind-mount source path as root, which breaks subsequent writes from
# the container. A previous failed run with a different layout (or a Docker
# restart that re-created a parent) can leave root-owned subdirs even after
# the installer re-creates them — `mkdir -p` is a no-op on existing dirs.
#
# `excludes` lists paths to skip (e.g. postgres data, which the postgres
# container manages as UID 70 — chowning it to the host user breaks the DB).
fix_ownership() {
    local target=$1
    shift
    local excludes=("$@")
    [[ -d "$target" ]] || return 0

    local find_args=()
    for ex in "${excludes[@]}"; do
        find_args+=(-not -path "${ex}*")
    done

    # Cheap path: try without sudo first. Succeeds when everything is already
    # owned correctly or we own all the (non-excluded) files.
    if find "$target" "${find_args[@]}" -print0 2>/dev/null \
       | xargs -0 chown "$HOST_UID:$HOST_GID" 2>/dev/null; then
        return 0
    fi
    # Slow path: at least one entry needs sudo.
    warn "fixing $target ownership (some entries owned by root — likely Docker auto-created on a prior run)"
    find "$target" "${find_args[@]}" -print0 2>/dev/null \
        | sudo xargs -0 chown "$HOST_UID:$HOST_GID" \
        || warn "could not chown $target — sandbox may fail to create subdirs"
}
# Skip postgres data — postgres-alpine container runs as UID 70 and manages
# that dir itself. Touching it from here causes "could not open … pg_filenode.map".
fix_ownership "$DATA_DIR" "$DATA_DIR/store/postgres"
fix_ownership "$AGENT_HOME_DIR"

# Distribute runtime skills and rules from the agent kit, not Board's developer skills.
bash "$INSTALL_DIR/carapa-agent-kit/scripts/install.sh" --agent-home "$AGENT_HOME_DIR"
fix_ownership "$STACKS_DIR"

if [[ "$WITH_WHATSAPP" == "true" ]]; then
    set_env_var "$board_env" ENABLE_WHATSAPP   "true"
    set_env_var "$board_env" MCP_WHATSAPP_URL  "http://carapa-wa-link-carapawalink-1:3467/mcp"
else
    set_env_var "$board_env" ENABLE_WHATSAPP   "false"
fi
ok "carapa-board .env written ($board_env)"

if [[ "$WITH_BRAIN" == "true" ]]; then
    brain_env="$STACKS_DIR/carapa-brain/.env"
    brain_digest="$(tr -d '\n' < "$SECRETS_BOARD_DIR/carapa_brain_auth_token" | openssl dgst -sha256 -r | cut -d' ' -f1)"
    set_env_var "$brain_env" CARAPA_BRAIN_AUTH_TOKEN_SHA256 "$brain_digest"
    set_env_var "$brain_env" AGENT_HOME      "$AGENT_HOME_DIR"
    set_env_var "$brain_env" SSH_KEYS_FOLDER "$HOME/.ssh"
    # One Brain instance serves every Board group from the groups directory.
    set_env_var "$brain_env" GROUP_DIR       "$DATA_DIR/groups"
    set_env_var "$brain_env" LOCAL_REPO      "$DATA_DIR/groups"
    set_env_var "$brain_env" IPC_MOUNT       "$DATA_DIR/data/ipc"
    ok "carapa-brain stack .env written ($brain_env)"
fi

# Seed a valid v2 runtime catalog. Only written if the file doesn't already
# exist; we never overwrite user configuration. defaults.chat and
# defaults.kanban.fallback must name a declared binding before any account is
# connected, so one Codex model is declared by hand; the codex account's other
# models arrive through discovery. No local model is assumed: the Direct
# harness stays empty (hidden) until the setup skill adds a binding.
agents_file="$DATA_DIR/data/board_agents.jsonc"
agents_seeded="false"
if [[ ! -f "$agents_file" ]]; then
    cat > "$agents_file" <<'EOF'
{
  "version": 2,
  "harnesses": {
    "direct": { "label": "Direct LLM", "kind": "direct" },
    "codex": { "label": "Codex", "kind": "cli", "agentCmd": "codex", "icon": "/harness-icons/codex.svg", "discover": { "account": "codex" } }
  },
  "models": {
    "gpt-6.2-sol": { "label": "GPT-6.2 Sol", "bindings": { "codex": { "model": "gpt-6.2-sol" } } }
  },
  "defaults": {
    "chat": { "harnessId": "codex", "modelId": "gpt-6.2-sol" },
    "kanban": { "fallback": { "harnessId": "codex", "modelId": "gpt-6.2-sol" }, "stages": {} }
  }
}
EOF
    ok "seeded $agents_file with a version-2 runtime catalog"
    agents_seeded="true"
else
    info "$agents_file already exists — keeping user config"
fi

# ── Step 10b: Deployment Compose files ───────────────────────────────────
# Compose runs from the deploy dir, never from a checkout: it trusts every
# file in its project dir (compose files, overrides, .env), and sandbox
# agents edit the checkouts. The repository Compose files reference their
# checkout only through CARAPA_*_SOURCE_DIR, so they are copied unchanged.
install_deploy_file "$INSTALL_DIR/carapa-box/docker-compose.yml"   "$BOX_DEPLOY/docker-compose.yml"
install_deploy_file "$INSTALL_DIR/carapa-board/docker-compose.yml" "$BOARD_DEPLOY/docker-compose.yml"
egress_src="$INSTALL_DIR/carapa-box/egress-proxy"
install_deploy_file "$egress_src/docker-compose.yml"  "$EGRESS_DEPLOY/docker-compose.yml"
install_deploy_file "$egress_src/before-start.sh"     "$EGRESS_DEPLOY/before-start.sh" 755
install_deploy_file "$egress_src/squid.conf"          "$EGRESS_DEPLOY/squid.conf"
install_deploy_file "$egress_src/squid-entrypoint.sh" "$EGRESS_DEPLOY/squid-entrypoint.sh" 755
install_deploy_file "$egress_src/policy.rego"         "$EGRESS_DEPLOY/policy.rego"
# Operator configuration: seed once, never overwrite.
if [[ ! -f "$EGRESS_DEPLOY/tool_profiles.jsonc" ]]; then
    if [[ -f "$egress_src/tool_profiles.jsonc" ]]; then
        install -m 644 "$egress_src/tool_profiles.jsonc" "$EGRESS_DEPLOY/tool_profiles.jsonc"
    else
        install -m 644 "$egress_src/tool_profiles.example.jsonc" "$EGRESS_DEPLOY/tool_profiles.jsonc"
    fi
fi
# Private copies of the seccomp profiles the deployed containers use.
install -m 644 "$INSTALL_DIR/carapa-box/security/"seccomp-*.json "$SECURITY_DEPLOY/"
ok "deployment Compose files and seccomp profiles in $DEPLOY_DIR"

# carapa-board's tracked compose hardcodes ports + the box/wa URLs in
# `environment:`, so we can't change those via `.env` alone. Compose loads
# docker-compose.override.yml from the deploy dir automatically.
write_board_override() {
    local f="$BOARD_DEPLOY/docker-compose.override.yml"
    local wa_env=""
    # CarapaBox polls the Board health URL through host.docker.internal, which
    # is the Docker host gateway and never matches a loopback-only publish.
    # Publish the same port on that gateway address too, unless the operator
    # already publishes on every interface (a second bind would collide).
    local gw_port=""
    local board_bind
    board_bind="$(get_env_var "$board_env" CARAPA_BOARD_BIND)"
    if [[ "$board_bind" != "0.0.0.0" ]]; then
        local gw
        gw="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || true)"
        gw_port="      - \"${gw:-172.17.0.1}:${BOARD_HOST_PORT}:3000\""
    fi
    if [[ "$WITH_WHATSAPP" == "true" ]]; then
        wa_env="      - MCP_WHATSAPP_URL=http://carapa-wa-link-carapawalink-1:3467/mcp"
    fi
    cat > "$f" <<EOF
# Generated by quick-install.sh — do not edit by hand.
# Override the tracked compose to:
#  - publish on the user-selected host port instead of the tracked 3000
#    (loopback unless CARAPA_BOARD_BIND is set in the deploy .env), plus the
#    Docker host gateway so CarapaBox can poll its health URL. If you later set
#    CARAPA_BOARD_BIND=0.0.0.0, re-run the installer (or drop the gateway line).
#  - point CARAPA_BOX_URL at the chosen box host port
services:
  carapa-board:
    ports: !override
      - "\${CARAPA_BOARD_BIND:-127.0.0.1}:${BOARD_HOST_PORT}:3000"
${gw_port}
    environment:
      - CARAPA_BOX_URL=http://host.docker.internal:${BOX_HOST_PORT}
${wa_env}
EOF
}
write_board_override
# Older installers wrote this override into the checkout; it is regenerated above.
rm -f "$INSTALL_DIR/carapa-board/docker-compose.override.yml"
ok "carapa-board docker-compose.override.yml"

# CarapaBox build_service/restart_service: build from the checkout, run
# Compose in the deploy dir. The short-lived Compose helper needs the secret
# and seccomp directories at their host paths. Never overwrite operator edits.
managed_services="$BOX_CONFIG_DIR/managed-services.yaml"
if [[ ! -f "$managed_services" ]]; then
    cat > "$managed_services" <<EOF
# Generated by quick-install.sh; edit to add more services.
carapa-board:
  composeDir: $BOARD_DEPLOY
  buildDir: $INSTALL_DIR/carapa-board
  helperReadOnlyPaths:
    - $SECURITY_DEPLOY
    - $SECRETS_BOARD_DIR
  healthUrl: http://host.docker.internal:${BOARD_HOST_PORT}/health
  service: carapa-board
EOF
    ok "managed-services.yaml: carapa-board deploys from $BOARD_DEPLOY"
elif grep -qE "composeDir: *$INSTALL_DIR/carapa-board/?$" "$managed_services"; then
    warn "$managed_services deploys carapa-board from its checkout; set composeDir: $BOARD_DEPLOY and buildDir: $INSTALL_DIR/carapa-board"
fi

# ── Step 11: Configure carapa-wa-link .env + compose ─────────────────────
if [[ "$WITH_WHATSAPP" == "true" ]]; then
    step "Configure carapa-wa-link"
    # Like Box and Board, wa-link runs from the deploy dir. Its store/ holds
    # the WhatsApp session keys, so it must not stay in the checkout either.
    mkdir -p "$WA_DEPLOY"
    chmod 700 "$WA_DEPLOY"
    wa_env="$WA_DEPLOY/.env"
    adopt_env "$INSTALL_DIR/carapa-wa-link/.env" "$wa_env" "$INSTALL_DIR/carapa-wa-link/.env.example"
    if [[ -d "$INSTALL_DIR/carapa-wa-link/store" && ! -e "$WA_DEPLOY/store" ]]; then
        mv "$INSTALL_DIR/carapa-wa-link/store" "$WA_DEPLOY/store"
        ok "moved the WhatsApp store to $WA_DEPLOY/store"
    fi
    mkdir -p "$WA_DEPLOY/store"
    set_env_var "$wa_env" MCP_PORT     "3467"
    set_env_var "$wa_env" STORE_DIR    "./store"
    set_env_var "$wa_env" BROWSER_NAME "CarapaBot"

    # wa-link doesn't ship a docker-compose.yml — generate one. Service name
    # `carapawalink` + project name `carapa-wa-link` produces the container
    # name `carapa-wa-link-carapawalink-1` that the board's compose expects.
    # Older installers generated it in the checkout; remove only that copy.
    legacy_wa_compose="$INSTALL_DIR/carapa-wa-link/docker-compose.yml"
    if [[ -f "$legacy_wa_compose" ]] && head -n 1 "$legacy_wa_compose" | grep -q '^# Generated by quick-install.sh'; then
        rm -f "$legacy_wa_compose"
    fi
    wa_compose="$WA_DEPLOY/docker-compose.yml"
    cat > "$wa_compose" <<EOF
# Generated by quick-install.sh.
name: carapa-wa-link
services:
  carapawalink:
    build: $INSTALL_DIR/carapa-wa-link
    image: carapa-wa-link:latest
    restart: unless-stopped
    ports:
      - "${WA_HOST_PORT}:3467"
    volumes:
      - ./store:/app/store
    env_file:
      - .env
    networks:
      - board_walink

networks:
  board_walink:
    external: true
    name: board_walink
EOF
    ok "carapa-wa-link configured ($WA_DEPLOY)"
else
    step "Skip carapa-wa-link (use --with-whatsapp to enable)"
fi

# CarapaMail runs from the deploy dir like Box and Board. Its repository
# Compose file is copied unchanged; the generated override points the build
# context and the read-only prompts mount at the checkout.
if [[ "$WITH_MAIL" == "true" ]]; then
    mkdir -p "$MAIL_DEPLOY"
    chmod 700 "$MAIL_DEPLOY"
    install_deploy_file "$INSTALL_DIR/carapa-mail/docker-compose.yml" "$MAIL_DEPLOY/docker-compose.yml"
    cat > "$MAIL_DEPLOY/docker-compose.override.yml" <<EOF
# Generated by quick-install.sh — do not edit by hand.
services:
  carapamail:
    build:
      context: $INSTALL_DIR/carapa-mail
    volumes:
      - $INSTALL_DIR/carapa-mail/prompts:/app/prompts:ro
EOF
    mail_env="$MAIL_DEPLOY/.env"
    adopt_env "$INSTALL_DIR/carapa-mail/.env" "$mail_env" "$INSTALL_DIR/carapa-mail/.env.example"
    set_env_var "$mail_env" SECRETS_DIR "$SECRETS_MAIL_DIR"
    # Agents reach Mail through the relay's carapa-mail route, which targets
    # carapa-mail-carapamail-1:3477 (also Board's default CARAPA_MAIL_MCP_URL).
    set_env_var "$mail_env" MCP_ENABLED    "true"
    set_env_var "$mail_env" MCP_PORT       "3477"
    set_env_var "$mail_env" MCP_PUBLIC_URL "http://carapa-mail-carapamail-1:3477/mcp"
    # No LLM is configured on a fresh install: start in rule-only mode. Put an
    # API key in $SECRETS_MAIL_DIR/anthropic_api_key and set
    # AI_FEATURES_ENABLED=true in $mail_env to enable AI filtering.
    if [[ ! -s "$SECRETS_MAIL_DIR/anthropic_api_key" ]] && [[ -z "$(get_env_var "$mail_env" ANTHROPIC_AUTH_TOKEN)" ]]; then
        set_env_var "$mail_env" AI_FEATURES_ENABLED "false"
    fi
    MAIL_HTTP_PORT="$(get_env_var "$mail_env" HTTP_PORT)"
    MAIL_HTTP_PORT="${MAIL_HTTP_PORT:-3200}"
    ok "carapa-mail configured ($MAIL_DEPLOY)"
fi

# ── Step 12: AppArmor profiles ───────────────────────────────────────────
# Loaded from private copies in the deploy dir, like the seccomp profiles, so
# root never runs a script from a checkout that sandbox agents can edit.
if [[ "$APPARMOR_ENABLED" == "true" && "$SKIP_PREREQS" != "true" ]]; then
    step "Load AppArmor profiles"
    DEPLOY_FILE_CHANGED="false"
    for f in "$INSTALL_DIR/carapa-box/security/"apparmor-*; do
        install_deploy_file "$f" "$SECURITY_DEPLOY/$(basename "$f")"
    done
    install_deploy_file "$INSTALL_DIR/carapa-box/security/install-apparmor.sh" "$SECURITY_DEPLOY/install-apparmor.sh" 755
    apparmor_stamp="$SECURITY_DEPLOY/.apparmor-loaded"
    if [[ "$DEPLOY_FILE_CHANGED" == "true" || ! -f "$apparmor_stamp" ]]; then
        info "loading CarapaBox AppArmor profiles (requires sudo)"
        sudo bash "$SECURITY_DEPLOY/install-apparmor.sh"
        touch "$apparmor_stamp"
        ok "AppArmor profiles loaded"
    else
        ok "AppArmor profiles unchanged since last load"
    fi
else
    step "Skip AppArmor profiles (AppArmor not enabled on this host, or --skip-prereqs)"
fi

# ── Step 12b: gVisor runtime ─────────────────────────────────────────────
# The seeded carapa-bot stack sets `runtime: runsc`; without that runtime Docker
# refuses to create the sandbox ("unknown or invalid runtime name: runsc").
# Installing it reloads the Docker daemon, so the user runs it, from a private
# copy like the AppArmor installer.
if [[ "$OS" != "mac" ]] \
   && ! docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"runsc"'; then
    mkdir -p "$SECURITY_DEPLOY"
    install_deploy_file "$INSTALL_DIR/carapa-box/scripts/install-gvisor.sh" "$SECURITY_DEPLOY/install-gvisor.sh" 755
    if [[ "$SKIP_PREREQS" == "true" ]]; then
        warn "Docker has no gVisor runtime (runsc); carapa-bot sandboxes will not start until it is installed:"
        info "  sudo bash $SECURITY_DEPLOY/install-gvisor.sh"
    else
        fail "Docker has no gVisor runtime (runsc), which the carapa-bot sandbox requires."
        info "Install it (a Docker daemon reload, not a restart), then re-run this script:"
        info "  sudo bash $SECURITY_DEPLOY/install-gvisor.sh"
        exit 1
    fi
fi

# ── Step 13: Build & start carapa-box ────────────────────────────────────
step "Build & start carapa-box"
cd "$INSTALL_DIR/carapa-box"

info "building egress-proxy images (this creates placeholder secrets too)"
SECRETS_DIR="$SECRETS_BOX_DIR" CARAPA_EGRESS_DEPLOY_DIR="$EGRESS_DEPLOY" bash egress-proxy/build.sh

# Export SANDBOX_STACKS_DIR (and SECRETS_DIR) so carapa-box/build.sh picks
# them up from the shell environment — it does not source .env. Without this,
# build.sh falls back to its in-repo ./stacks and compiles policy.wasm into
# the WRONG stacks tree. Without policy.wasm, carapa-box refuses to register
# the stack at runtime ("stack not found"). CARAPA_BOX_DEPLOY_DIR makes it
# build with the deployment Compose file.
info "building carapa-box image + compiling OPA policies for $STACKS_DIR"
CARAPA_BOX_DEPLOY_DIR="$BOX_DEPLOY" \
    SANDBOX_STACKS_DIR="$STACKS_DIR" \
    SECRETS_DIR="$SECRETS_BOX_DIR" \
    bash build.sh

info "starting carapa-box stack from $BOX_DEPLOY"
(cd "$BOX_DEPLOY" && docker compose up -d)

info "waiting for box health endpoint on :${BOX_HOST_PORT}"
if wait_http "http://127.0.0.1:${BOX_HOST_PORT}/health" 90; then
    ok "carapa-box healthy"
else
    fail "carapa-box did not come up in 90s"
    info "check logs: (cd $BOX_DEPLOY && docker compose logs)"
    exit 1
fi

# ── Step 14: Build sandbox stack images ──────────────────────────────────
# carapa-box launches per-task agent containers using these images. Without
# this step, `sandbox_start` fails with "stack not found" — the docker-compose
# in $STACKS_DIR/<stack>/ references an image tag that doesn't exist yet.
# Each stack ships its own build.sh; we just walk the dir and run them.
# carapa-bot is required: every agent sandbox, Brain and the browser helper
# use its image.
step "Build sandbox stack images"
info "building stack: carapa-bot ($BOT_IMAGE)"
( cd "$STACKS_DIR/carapa-bot" && bash build.sh ${BOT_SCAN_ARGS[@]+"${BOT_SCAN_ARGS[@]}"} )
ok "built carapa-bot"
shopt -s nullglob
for stack_dir in "$STACKS_DIR"/*/; do
    stack_name="$(basename "$stack_dir")"
    [[ "$stack_name" == "carapa-bot" ]] && continue
    if [[ -f "$stack_dir/build.sh" ]]; then
        info "building stack: $stack_name"
        ( cd "$stack_dir" && bash build.sh ) || {
            warn "build failed for $stack_name — sandbox starts using it will fail until you fix it"
            continue
        }
        ok "built $stack_name"
    else
        info "$stack_name has no build.sh — skipping"
    fi
done
shopt -u nullglob

# ── Step 15: Install agent harnesses ─────────────────────────────────────
# The runtime image contains no agent CLIs. harness.py installs them into a
# validated, read-only volume that every carapa-bot (and Brain) sandbox mounts;
# a sandbox cannot start until a selection exists. Re-runs add only missing ones.
step "Install agent harnesses"
harness_py="$STACKS_DIR/carapa-bot/harness.py"
read -r -a wanted_harnesses <<< "$HARNESSES"
missing_harnesses=()
for h in ${wanted_harnesses[@]+"${wanted_harnesses[@]}"}; do
    if ! python3 -c 'import json,sys; sys.exit(0 if sys.argv[2] in json.load(open(sys.argv[1])).get("harnesses", {}) else 1)' \
         "$STACKS_DIR/carapa-bot/.harness/active/selection.json" "${h%%@*}" 2>/dev/null; then
        missing_harnesses+=("$h")
    fi
done
if [[ ${#wanted_harnesses[@]} -eq 0 ]]; then
    [[ -f "$STACKS_DIR/carapa-bot/.harness/active/selection.json" ]] || python3 "$harness_py" install none
    warn "no harnesses selected — agents cannot run until you install one (python3 $harness_py install codex)"
elif [[ ${#missing_harnesses[@]} -gt 0 ]]; then
    info "installing: ${missing_harnesses[*]}"
    python3 "$harness_py" install "${missing_harnesses[@]}"
    ok "harnesses installed: ${missing_harnesses[*]}"
else
    ok "harnesses already installed: $HARNESSES"
fi
python3 "$harness_py" check

# The provider sign-in worker mounts the harness volume read-only to run the
# provider CLI (codex, claude, ...). The volume changes with the selection and
# the runtime image, so point Box at the current one and recreate Box if needed.
harness_volume="$(python3 "$harness_py" status | python3 -c 'import json,sys; print(json.load(sys.stdin).get("volume") or "")')"
if [[ -n "$harness_volume" && "$harness_volume" != "$(get_env_var "$box_env" PROVIDER_LOGIN_HARNESS_VOLUME)" ]]; then
    set_env_var "$box_env" PROVIDER_LOGIN_HARNESS_VOLUME "$harness_volume"
    info "provider sign-in uses harness volume $harness_volume; recreating carapa-box"
    (cd "$BOX_DEPLOY" && docker compose up -d carapa-box)
    if wait_http "http://127.0.0.1:${BOX_HOST_PORT}/health" 90; then
        ok "carapa-box healthy"
    else
        fail "carapa-box did not come back in 90s"
        info "check logs: (cd $BOX_DEPLOY && docker compose logs)"
        exit 1
    fi
fi

# ── Step 16: Build & start carapa-brain (optional) ───────────────────────
if [[ "$WITH_BRAIN" == "true" ]]; then
    step "Build & start carapa-brain"
    info "building carapa-brain image on $BOT_IMAGE"
    (cd "$INSTALL_DIR/carapa-brain" && CARAPA_BOT_IMAGE="$BOT_IMAGE" bash build.sh ${BOT_SCAN_ARGS[@]+"${BOT_SCAN_ARGS[@]}"})
    info "starting the carapa-brain sandbox (instance main)"
    if brain_start="$(box_tool sandbox_start '{"name":"carapa-brain","instance":"main"}')" \
       && ! grep -q '"isError":true' <<< "$brain_start"; then
        ok "carapa-brain started (container carapa-brain-main-agent-1)"
    else
        warn "carapa-brain did not start: $(sed -n 's/^data: //p' <<< "${brain_start:-}" | head -c 600)"
        info "check: docker logs carapa-brain-main-agent-1"
    fi
else
    step "Skip carapa-brain (use --with-brain to enable)"
fi


# ── Step 17: Build & start carapa-board ──────────────────────────────────
step "Build & start carapa-board"
cd "$INSTALL_DIR/carapa-board"

# board_walink network is owned by board's compose (no `external: true`).
# wa-link's compose attaches to it as external, so board starts first.

info "building carapa-board image"
CARAPA_BOARD_DEPLOY_DIR="$BOARD_DEPLOY" bash build.sh

info "starting carapa-board stack from $BOARD_DEPLOY"
(cd "$BOARD_DEPLOY" && docker compose up -d)

info "waiting for board on https://127.0.0.1:${BOARD_HOST_PORT}"
if wait_http "https://127.0.0.1:${BOARD_HOST_PORT}" 90; then
    ok "carapa-board responding"
else
    warn "carapa-board didn't respond on :${BOARD_HOST_PORT} within 90s — check: (cd $BOARD_DEPLOY && docker compose logs)"
fi

# ── Step 18: Build & start carapa-wa-link (optional) ─────────────────────
# After Board: Board's Compose project creates the board_walink network.
if [[ "$WITH_WHATSAPP" == "true" ]]; then
    step "Build & start carapa-wa-link"
    cd "$INSTALL_DIR/carapa-wa-link"
    info "building wa-link image"
    bash build.sh
    info "starting wa-link stack from $WA_DEPLOY"
    (cd "$WA_DEPLOY" && docker compose up -d)
    info "waiting for wa-link on :${WA_HOST_PORT}"
    if wait_http "http://127.0.0.1:${WA_HOST_PORT}/health" 60; then
        ok "carapa-wa-link healthy"
    else
        warn "carapa-wa-link didn't respond — QR auth still needed (Step 5 of /setup skill)"
    fi
else
    step "Skip wa-link startup"
fi

# ── Step 19: Build & start carapa-mail (optional) ────────────────────────
if [[ "$WITH_MAIL" == "true" ]]; then
    step "Build & start carapa-mail"
    info "building carapa-mail image"
    docker build -t carapamail:latest "$INSTALL_DIR/carapa-mail"
    info "starting carapa-mail from $MAIL_DEPLOY"
    (cd "$MAIL_DEPLOY" && docker compose up -d --no-build)
    if wait_http "http://127.0.0.1:${MAIL_HTTP_PORT}/health" 60; then
        ok "carapa-mail healthy"
    else
        warn "carapa-mail didn't respond on :${MAIL_HTTP_PORT} — check: (cd $MAIL_DEPLOY && docker compose logs)"
    fi
else
    step "Skip carapa-mail (use --with-mail to enable)"
fi

# ── Step 20: Persist state + print summary ───────────────────────────────
step "Persist install state"
cat > "$INSTALL_STATE_FILE" <<EOF
# Carapa install state — generated by quick-install.sh
INSTALL_DIR=$INSTALL_DIR
STACKS_DIR=$STACKS_DIR
DATA_DIR=$DATA_DIR
AGENT_HOME_DIR=$AGENT_HOME_DIR
DEPLOY_DIR=$DEPLOY_DIR
BOARD_HOST_PORT=$BOARD_HOST_PORT
BOX_HOST_PORT=$BOX_HOST_PORT
WA_HOST_PORT=$WA_HOST_PORT
WITH_WHATSAPP=$WITH_WHATSAPP
WITH_BRAIN=$WITH_BRAIN
WITH_MAIL=$WITH_MAIL
SCRIPT_VERSION=$SCRIPT_VERSION
EOF
ok "wrote $INSTALL_STATE_FILE"

# A fresh Board prints the generated admin password once in its startup log.
BOARD_ADMIN_PASSWORD="$(docker logs carapa-board 2>&1 | sed -n 's/^  password: //p' | tail -n1)"

cat <<EOF

${c_green}${c_bold}═══════════════════════════════════════════════════════════${c_reset}
${c_green}${c_bold}  Carapa is up.${c_reset}
${c_green}${c_bold}═══════════════════════════════════════════════════════════${c_reset}

  Board UI    : ${c_bold}https://localhost:${BOARD_HOST_PORT}${c_reset}
                Trust the local CA ${DATA_DIR}/store/certs/ca.crt as an authority
                in your browser (Firefox: Settings → Certificates → Authorities →
                Import; the Firefox snap needs a copy outside hidden dirs, e.g.
                ~/Downloads). See carapa-board/docs/tls-cert-trust.md.
                Login:  username = ${c_bold}admin${c_reset}
                        password = ${c_bold}${BOARD_ADMIN_PASSWORD:-your existing admin password}${c_reset}
                        (change it after the first sign-in; it is shown only once)
  Box API     : http://localhost:${BOX_HOST_PORT}
EOF
if [[ "$WITH_WHATSAPP" == "true" ]]; then
    echo "  WA-Link MCP : http://localhost:${WA_HOST_PORT}/mcp"
fi
if [[ "$WITH_MAIL" == "true" ]]; then
    echo "  Mail setup  : http://localhost:${MAIL_HTTP_PORT}/setup   (admin token: $SECRETS_MAIL_DIR/carapa_mail_token)"
fi
if [[ "$WITH_BRAIN" == "true" ]]; then
    echo "  Brain       : container carapa-brain-main-agent-1   (auth token: $SECRETS_BOARD_DIR/carapa_brain_auth_token)"
fi
cat <<EOF
  Stacks dir  : ${STACKS_DIR}    (your personal stacks — never edit carapa-box/stacks/)
  Data dir    : ${DATA_DIR}      (groups, transcripts, ipc — safe to back up or move)
  Agent home  : ${AGENT_HOME_DIR}  (sandbox /home/ubuntu — sandboxed CLI auth lives here, NOT in your host \$HOME)
  Deploy dir  : ${DEPLOY_DIR}  (Compose files + .env for Box and Board — operator-only, never mount it into a sandbox)

  Next steps:
    cd $INSTALL_DIR/carapa-board
    claude    # then run /setup to finish agent auth$( [[ "$WITH_WHATSAPP" == "true" ]] && echo ", WhatsApp QR" )$( [[ "$WITH_BRAIN" == "true" ]] && echo ", Brain project settings" )$( [[ "$WITH_MAIL" == "true" ]] && echo ", mail account" )

EOF

if [[ "$agents_seeded" == "true" ]]; then
    cat <<EOF
  ${c_yellow}${c_bold}!  Configure a runtime before using Kanban agents${c_reset}
    Chat and Kanban default to ${c_bold}codex${c_reset} (gpt-6.2-sol), which answers once a
    ChatGPT account is connected. Installed sandbox CLIs: ${HARNESSES:-none}
    (add more: python3 $STACKS_DIR/carapa-bot/harness.py install claude).
    Credentials stay with CarapaBox's relay, never in ${AGENT_HOME_DIR}:
      1) Connect each provider in Board → Provider accounts (a sign-in or an API key).
      2) Apply the harness's own configuration (Codex: ${AGENT_HOME_DIR}/.codex/config.toml
         pointing at the relay) and set the catalog defaults.
    The /setup skill does both and verifies each agent
    (.agent/skills/setup/references/agent-runtimes.md). Do not log a CLI in inside
    the sandbox or copy ~/.claude, ~/.codex or ~/.gemini into ${AGENT_HOME_DIR}:
    a Codex auth.json there bypasses the relay.

  ${c_yellow}${c_bold}!  Automatic memory is off${c_reset}
    The transcript memory reflector needs a model of its own. The /setup
    skill asks which provider and model to use, then sets defaults.reflector
    and defaults.observer in ${agents_file}
    and ENABLE_MEMORY_REFLECTOR=true in ${BOARD_DEPLOY}/.env.

EOF
fi
