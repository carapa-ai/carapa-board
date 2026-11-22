#!/usr/bin/env bash
# Remove a CarapaBoard installation. Prints the plan and changes nothing unless
# --yes is given. Never sources .env files and never prints secret contents.
#
# Default scope: containers, networks and Compose volumes of CarapaBoard and of
# the optional parts deployed next to it (WhatsApp link, Brain, Mail). Opt in to:
#   --images      the carapa-* images those containers used
#   --data        Board data: <data>/{data,groups,store,knowledge} (database,
#                 chats, projects, certificates) and the logs directory
#   --secrets     the secret files Board's Compose files declare under SECRETS_DIR
#   --state       Board's .env and docker-compose.override.yml (untracked or in the
#                 deploy dir) and the installer record ~/.carapa/install.env
#   --agent-home  the sandbox agent home recorded in install.env (skills, CLI config)
#   --with-box    also run CarapaBox's uninstall.sh with the same scopes
#   --host        as root, on its own: remove Board's AppArmor profile (and, with
#                 --with-box, CarapaBox's profiles and gVisor)
# Files only root can remove (Postgres data, Docker-created directories) are listed
# with the command to remove them.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)"
fail() { printf 'uninstall: %s\n' "$*" >&2; exit 1; }
usage() {
    sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    echo 'Usage: bash uninstall.sh [--board-dir DIR] [--box-dir DIR] [--images] [--data] [--secrets]'
    echo '                         [--state] [--agent-home] [--with-box] [--yes]'
    echo '       sudo bash uninstall.sh --host [--with-box] [--yes]'
}
apply=0 images=0 data=0 secrets=0 state=0 agent_home=0 with_box=0 host=0
board_dir='' box_dir=''
install_env="${CARAPA_INSTALL_ENV:-$HOME/.carapa/install.env}"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --board-dir) [[ $# -ge 2 ]] || fail '--board-dir requires a path'; board_dir=$2; shift 2 ;;
        --box-dir) [[ $# -ge 2 ]] || fail '--box-dir requires a path'; box_dir=$2; shift 2 ;;
        --images) images=1; shift ;;
        --data) data=1; shift ;;
        --secrets) secrets=1; shift ;;
        --state) state=1; shift ;;
        --agent-home) agent_home=1; shift ;;
        --with-box) with_box=1; shift ;;
        --host) host=1; shift ;;
        --yes) apply=1; shift ;;
        --help|-h) usage; exit 0 ;;
        *) fail "unknown option: $1" ;;
    esac
done

run() {
    printf '  %s\n' "$*"
    [[ $apply -eq 0 ]] || "$@" || printf '    (failed, continuing)\n' >&2
}
# KEY=value reader: values are data, never evaluated (same rules as CarapaBox's helpers).
env_value() {
    local file=$1 key=$2 line value='' pattern
    [[ -r "$file" ]] || return 0
    pattern="^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=(.*)$"
    while IFS= read -r line || [[ -n "$line" ]]; do
        if [[ "$line" =~ $pattern ]]; then
            value=${BASH_REMATCH[2]}
            value="${value#"${value%%[![:space:]]*}"}"
            if [[ "$value" == \"* || "$value" == \'* ]]; then
                local q=${value:0:1}; value=${value:1}; value=${value%%"$q"*}
            else
                value=${value%%[[:space:]]#*}; value="${value%"${value##*[![:space:]]}"}"
            fi
            [[ "$value" != *'$'* && "$value" != *'`'* ]] || value=''
        fi
    done < "$file"
    printf '%s' "$value"
}
# Refuse removals that would take more than CarapaBoard state with them.
safe_path() {
    local p=${1%/}
    [[ "$p" == /* && "$p" == */*/* && "$p" != "$HOME" ]] || return 1
    # Never the repository checkout itself (a deploy directory is fine).
    [[ "$p" != "$repo_root" && "$p" != "$(dirname "$repo_root")" ]] || return 1
}
root_only=()
remove_path() {
    local p=$1
    [[ -e "$p" || -L "$p" ]] || return 0
    safe_path "$p" || { printf '  skip unsafe path: %s\n' "$p"; return 0; }
    if [[ -n "$(find "$p" ! -user "$(id -u)" -print -quit 2>/dev/null)" ]]; then
        root_only+=("$p"); printf '  needs root: %s\n' "$p"; return 0
    fi
    run rm -rf -- "$p"
}
tracked() { git -C "$board_dir" ls-files --error-unmatch -- "$1" >/dev/null 2>&1; }

deploy_dir=$(env_value "$install_env" DEPLOY_DIR)
install_dir=$(env_value "$install_env" INSTALL_DIR)
if [[ -z "$board_dir" ]]; then
    if [[ -n "$deploy_dir" && -f "$deploy_dir/carapa-board/docker-compose.yml" ]]; then board_dir="$deploy_dir/carapa-board"
    else board_dir=$repo_root; fi
fi
[[ -f "$board_dir/docker-compose.yml" ]] || fail "no docker-compose.yml in $board_dir (use --board-dir)"
board_dir="$(cd "$board_dir" && pwd -P)"
if [[ -z "$box_dir" ]]; then
    for c in "$install_dir/carapa-box" "$(dirname "$repo_root")/carapa-box"; do
        [[ -f "$c/.agent/skills/setup/scripts/uninstall.sh" ]] && { box_dir=$c; break; }
    done
fi
box_uninstall="${box_dir:+$box_dir/.agent/skills/setup/scripts/uninstall.sh}"
[[ $with_box -eq 0 || -f "$box_uninstall" ]] || fail 'CarapaBox checkout not found (use --box-dir)'

if [[ $host -eq 1 ]]; then
    (( images + data + secrets + state + agent_home == 0 )) || fail '--host runs on its own; run the other scopes as the operator user'
    [[ $EUID -eq 0 ]] || fail '--host must run as root (sudo)'
    echo '== AppArmor profile apparmor-board'
    if [[ -f /etc/apparmor.d/containers/apparmor-board ]]; then run apparmor_parser -R /etc/apparmor.d/containers/apparmor-board; fi
    for f in /etc/apparmor.d/apparmor-board /etc/apparmor.d/containers/apparmor-board; do
        [[ ! -e "$f" && ! -L "$f" ]] || run rm -f -- "$f"
    done
    if [[ $with_box -eq 1 ]]; then
        echo '== CarapaBox host components'
        box_args=(--host); [[ $apply -eq 0 ]] || box_args+=(--yes)
        bash "$box_uninstall" "${box_args[@]}"
    fi
    [[ $apply -eq 1 ]] || echo 'Dry run: nothing changed. Re-run with --yes to apply.'
    exit 0
fi
command -v docker >/dev/null 2>&1 || fail 'docker is required'

# Resolve everything from the .env files before --state can remove them.
board_env="$board_dir/.env"
data_dir=$(env_value "$board_env" CARAPA_DATA_DIR)
source_dir=$(env_value "$board_env" CARAPA_BOARD_SOURCE_DIR)
[[ -n "$data_dir" ]] || data_dir=$(env_value "$install_env" DATA_DIR)
[[ -n "$data_dir" ]] || data_dir=${source_dir:-$board_dir}
[[ -n "$source_dir" ]] || source_dir=$board_dir
secrets_dir=$(env_value "$board_env" SECRETS_DIR)
agent_home_dir=$(env_value "$install_env" AGENT_HOME_DIR)
secret_names=()
for f in "$board_dir/docker-compose.yml" "$board_dir/docker-compose.override.yml"; do
    [[ -f "$f" ]] || continue
    while IFS= read -r line || [[ -n "$line" ]]; do
        if [[ "$line" =~ file:[[:space:]]*\$\{SECRETS_DIR\}/([A-Za-z0-9_.-]+) ]]; then secret_names+=("${BASH_REMATCH[1]}"); fi
    done < "$f"
done

# Compose projects: Board itself, and optional parts deployed beside it.
declare -A projects=()
while IFS=$'\t' read -r project workdir; do
    [[ -n "$project" ]] || continue
    case "$workdir" in
        "$board_dir") projects[$project]=1 ;;
        "$deploy_dir"/carapa-wa-link|"$deploy_dir"/carapa-brain|"$deploy_dir"/carapa-mail) [[ -n "$deploy_dir" ]] && projects[$project]=1 ;;
    esac
done < <(docker ps -a --filter label=com.docker.compose.project \
    --format '{{.Label "com.docker.compose.project"}}	{{.Label "com.docker.compose.project.working_dir"}}' | sort -u)

echo "Board deployment: $board_dir"
[[ $apply -eq 1 ]] || echo 'Dry run: printing the plan only.'
echo '== Containers, networks and volumes'
image_refs=()
[[ ${#projects[@]} -gt 0 ]] || echo '  no CarapaBoard Compose projects found'
for project in $(printf '%s\n' "${!projects[@]}" | sort); do
    echo "  project $project"
    mapfile -t ids < <(docker ps -aq --filter "label=com.docker.compose.project=$project")
    if [[ ${#ids[@]} -gt 0 ]]; then
        mapfile -t -O "${#image_refs[@]}" image_refs < <(docker inspect --format '{{.Config.Image}}' "${ids[@]}")
        run docker rm -f "${ids[@]}"
    fi
    mapfile -t nets < <(docker network ls -q --filter "label=com.docker.compose.project=$project")
    [[ ${#nets[@]} -eq 0 ]] || run docker network rm "${nets[@]}"
    mapfile -t vols < <(docker volume ls -q --filter "label=com.docker.compose.project=$project")
    [[ ${#vols[@]} -eq 0 ]] || run docker volume rm "${vols[@]}"
done

if [[ $images -eq 1 ]]; then
    echo '== Images'
    image_refs+=(carapa-board:latest)
    for ref in $(printf '%s\n' "${image_refs[@]}" | sort -u); do
        # Only Carapa-built images; shared bases (postgres, the CarapaBot image) stay.
        case "$ref" in carapa-board*|carapa-brain*|carapa-mail*|carapa-wa-link*|*/carapa-board*) ;; *) continue ;; esac
        if docker image inspect "$ref" >/dev/null 2>&1; then run docker rmi "$ref"; fi
    done
fi

if [[ $secrets -eq 1 ]]; then
    echo '== Secrets'
    if [[ "$secrets_dir" != /* ]]; then echo "  no absolute SECRETS_DIR in $board_env, skipped"
    else
        for name in $(printf '%s\n' "${secret_names[@]}" | sort -u); do
            [[ ! -e "$secrets_dir/$name" ]] || run rm -f -- "$secrets_dir/$name"
        done
        if [[ -d "$secrets_dir" ]]; then
            if [[ $apply -eq 1 ]]; then rmdir -- "$secrets_dir" 2>/dev/null && echo "  rmdir $secrets_dir" || echo "  kept non-empty $secrets_dir"
            else echo "  rmdir $secrets_dir (if empty)"; fi
        fi
    fi
fi

if [[ $data -eq 1 ]]; then
    echo '== Data'
    for sub in data groups store knowledge; do remove_path "$data_dir/$sub"; done
    remove_path "$source_dir/logs"
    if [[ "$data_dir" != "$board_dir" && "$data_dir" != "$source_dir" && -d "$data_dir" ]]; then
        if [[ $apply -eq 1 ]]; then rmdir -- "$data_dir" 2>/dev/null && echo "  rmdir $data_dir" || echo "  kept non-empty $data_dir"
        else echo "  rmdir $data_dir (if empty)"; fi
    fi
fi

if [[ $agent_home -eq 1 ]]; then
    echo '== Agent home'
    if [[ "$agent_home_dir" == /* ]]; then remove_path "$agent_home_dir"
    else echo "  no AGENT_HOME_DIR in $install_env, skipped"; fi
fi

if [[ $state -eq 1 ]]; then
    echo '== State'
    for f in .env docker-compose.override.yml; do
        p="$board_dir/$f"
        [[ -e "$p" ]] || continue
        if [[ "$board_dir" == "$repo_root" ]] && tracked "$f"; then continue; fi
        run rm -f -- "$p"
    done
    if [[ -n "$deploy_dir" && "$board_dir" == "$deploy_dir/carapa-board" ]]; then remove_path "$board_dir"; fi
    [[ ! -f "$install_env" ]] || run rm -f -- "$install_env"
fi

if [[ $with_box -eq 1 ]]; then
    echo '== CarapaBox'
    box_args=()
    [[ $images -eq 0 ]] || box_args+=(--images)
    [[ $state -eq 0 ]] || box_args+=(--state)
    [[ $secrets -eq 0 ]] || box_args+=(--secrets)
    [[ $apply -eq 0 ]] || box_args+=(--yes)
    if [[ -n "$deploy_dir" && -f "$deploy_dir/carapa-box/docker-compose.yml" ]]; then
        box_args+=(--repo-root "$deploy_dir/carapa-box" --egress-dir "$deploy_dir/egress-proxy")
    fi
    bash "$box_uninstall" "${box_args[@]}"
fi

if [[ ${#root_only[@]} -gt 0 ]]; then
    echo '== Needs root'
    printf '  sudo rm -rf --'; printf ' %q' "${root_only[@]}"; echo
fi
echo '== Not removed'
[[ $data -eq 1 ]] || echo "  Board data in $data_dir (add --data)"
[[ $secrets -eq 1 ]] || echo '  secrets (add --secrets)'
[[ $agent_home -eq 1 || -z "$agent_home_dir" ]] || echo "  agent home $agent_home_dir (add --agent-home)"
[[ $with_box -eq 1 ]] || echo '  CarapaBox (add --with-box)'
echo '  AppArmor profile apparmor-board (run separately: sudo bash uninstall.sh --host --yes)'
[[ $apply -eq 1 ]] || echo 'Dry run: nothing changed. Re-run with --yes to apply.'
