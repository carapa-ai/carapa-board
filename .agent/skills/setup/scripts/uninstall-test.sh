#!/usr/bin/env bash
# Exercises uninstall.sh against a fixture deployment, a fake docker CLI and a stub CarapaBox uninstaller.
set -euo pipefail
scripts="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
fixture=$(mktemp -d "${TMPDIR:-/tmp}/carapaboard-uninstall-test.XXXXXX")
trap 'rm -rf -- "$fixture"' EXIT
board="$fixture/deploy/carapa-board" data="$fixture/data" secrets="$fixture/secrets" home="$fixture/agent-home"
box="$fixture/install/carapa-box"
mkdir -p "$board" "$data"/{data,groups,store,knowledge} "$secrets" "$home/.agent/skills" "$fixture/bin" \
    "$box/.agent/skills/setup/scripts" "$fixture/deploy/carapa-box" "$fixture/deploy/egress-proxy"
printf 'secrets:\n  a:\n    file: ${SECRETS_DIR}/postgres_password\n' > "$board/docker-compose.yml"
printf 'secrets:\n  k:\n    file: ${SECRETS_DIR}/carapa_board_encryption_key\n' > "$board/docker-compose.override.yml"
printf 'SECRETS_DIR=%s\nCARAPA_DATA_DIR="%s" # data\nCARAPA_BOARD_SOURCE_DIR=%s/src\nWEIRD=$(touch %s/executed)\n' \
    "$secrets" "$data" "$fixture" "$fixture" > "$board/.env"
printf 'private-fixture-token\n' > "$secrets/postgres_password"
printf 'private-fixture-token\n' > "$secrets/carapa_board_encryption_key"
printf 'unrelated\n' > "$secrets/keep_me"
mkdir -p "$fixture/src/logs"; touch "$data/store/db" "$home/.agent/skills/s"
touch "$fixture/deploy/carapa-box/docker-compose.yml"
printf 'INSTALL_DIR=%s/install\nDEPLOY_DIR=%s/deploy\nDATA_DIR=%s/ignored\nAGENT_HOME_DIR=%s\n' \
    "$fixture" "$fixture" "$fixture" "$home" > "$fixture/install.env"
# Stub CarapaBox uninstaller: records the arguments it gets.
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "%s/box.log"\n' "$fixture" > "$box/.agent/skills/setup/scripts/uninstall.sh"

cat > "$fixture/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FIXTURE/docker.log"
case "$*" in
    "ps -a --filter label=com.docker.compose.project --format"*)
        printf 'carapa-board\t%s/deploy/carapa-board\ncarapa-box\t%s/deploy/carapa-box\nother\t/elsewhere\n' "$FIXTURE" "$FIXTURE" ;;
    "ps -aq --filter label=com.docker.compose.project=carapa-board") printf 'b1\nb2\n' ;;
    "inspect --format {{.Config.Image}} b1 b2") printf 'carapa-board:latest\npostgres:16-alpine\n' ;;
    "network ls -q --filter label=com.docker.compose.project=carapa-board") echo n1 ;;
    "image inspect carapa-board:latest") exit 0 ;;
    "image inspect "*) exit 1 ;;
esac
DOCKER
chmod +x "$fixture/bin/docker"
export FIXTURE=$fixture PATH="$fixture/bin:$PATH" CARAPA_INSTALL_ENV="$fixture/install.env"

# Dry run: plan only, nothing evaluated, no secret printed.
cp -R "$fixture/deploy" "$fixture/before"
bash "$scripts/uninstall.sh" --images --data --secrets --state --agent-home --with-box > "$fixture/plan"
diff -qr "$fixture/before" "$fixture/deploy" >/dev/null
[[ -f "$secrets/postgres_password" && -f "$data/store/db" && -d "$home" && ! -e "$fixture/executed" ]]
if grep -q private-fixture-token "$fixture/plan"; then exit 1; fi
grep -q 'project carapa-board' "$fixture/plan"
if grep -qE 'project (carapa-box|other)' "$fixture/plan"; then exit 1; fi
if grep -qE '^(rm|network rm|volume rm|rmi)' "$fixture/docker.log"; then exit 1; fi
grep -q -- "--images --state --secrets --repo-root $fixture/deploy/carapa-box --egress-dir $fixture/deploy/egress-proxy" "$fixture/box.log"
if grep -q -- '--yes' "$fixture/box.log"; then exit 1; fi

# Default scope: Docker resources only.
bash "$scripts/uninstall.sh" --yes > /dev/null
grep -qx 'rm -f b1 b2' "$fixture/docker.log"
grep -qx 'network rm n1' "$fixture/docker.log"
[[ -f "$board/.env" && -f "$data/store/db" ]]

# Full scope.
: > "$fixture/docker.log"; : > "$fixture/box.log"
bash "$scripts/uninstall.sh" --images --data --secrets --state --agent-home --with-box --yes > "$fixture/out"
grep -qx 'rmi carapa-board:latest' "$fixture/docker.log"
if grep -q 'rmi postgres' "$fixture/docker.log"; then exit 1; fi
[[ ! -e "$secrets/postgres_password" && ! -e "$secrets/carapa_board_encryption_key" && -f "$secrets/keep_me" ]]
[[ ! -e "$data/data" && ! -e "$data/store" && ! -e "$fixture/src/logs" && ! -e "$data" ]]
[[ ! -e "$home" && ! -e "$board" && ! -e "$fixture/install.env" && ! -e "$fixture/executed" ]]
grep -q -- '--yes' "$fixture/box.log"

# --host refuses to mix with user scopes or to run unprivileged.
if bash "$scripts/uninstall.sh" --host --data 2>/dev/null; then exit 1; fi
if [[ $EUID -ne 0 ]] && bash "$scripts/uninstall.sh" --host 2>/dev/null; then exit 1; fi
echo 'uninstall-test: ok'
