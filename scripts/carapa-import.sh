#!/usr/bin/env bash
set -euo pipefail

# Import local git repos into carapa-board as projects.
#
# Usage: carapa-import <path> [default-sandbox] [default-sandbox-service]
#
# Single repo:  if <path>/.git exists, create one project.
# Multi-repo:   otherwise scan direct children for .git dirs,
#               create a parent project + child projects.
#
# Re-running updates settings on existing projects (sandbox, service, repo url/location).

usage() {
  cat <<'USAGE'
Usage: carapa-import <path> [default-sandbox] [default-sandbox-service]

Import local git repos into carapa-board as projects.

Arguments:
  path                    Directory to import
  default-sandbox         Stack name for child projects (e.g. php, carapa-bot)
  default-sandbox-service Service within the stack (e.g. php84, agent)

Setting default-sandbox or default-sandbox-service needs a board admin
session (CARAPA_BOARD_USER must be an admin); other users get a 403.

Modes:
  Single repo   If <path>/.git exists, create one kanban project.
  Multi-repo    If <path> has no .git but children do, create a parent
                project + a child project per git repo found.

Re-running updates existing projects (sandbox, service, repo url/location)
without overwriting stages or mode.

Environment:
  API_PORT                Board API port (default: 3000)
  CARAPA_BOARD_USER       Board username to sign in with (default: admin)
  CARAPA_BOARD_PASSWORD   Password for that user (required)

USAGE
  exit 0
}

[[ "${1:-}" == "--help" || "${1:-}" == "-h" || $# -eq 0 ]] && usage

API_BASE="http://localhost:${API_PORT:-3000}"

json_string() {
  local s="${1//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}

if [[ -z "${CARAPA_BOARD_PASSWORD:-}" ]]; then
  echo "Error: set CARAPA_BOARD_PASSWORD (and CARAPA_BOARD_USER if not admin)" >&2
  exit 1
fi
LOGIN_BODY="{\"username\":$(json_string "${CARAPA_BOARD_USER:-admin}"),\"password\":$(json_string "$CARAPA_BOARD_PASSWORD")}"
SESSION_TOKEN="$(curl -s -X POST "$API_BASE/api/auth/login" \
  -H 'Content-Type: application/json' -d "$LOGIN_BODY" |
  sed -n 's/.*"token":"\([A-Za-z0-9._-]*\)".*/\1/p')"
if [[ -z "$SESSION_TOKEN" ]]; then
  echo "Error: sign-in to $API_BASE failed" >&2
  exit 1
fi
AUTH_HEADER="Authorization: Bearer $SESSION_TOKEN"

TARGET="$1"
DEFAULT_SANDBOX="${2:-}"
DEFAULT_SERVICE="${3:-}"

TARGET="$(realpath "$TARGET")"

if [[ ! -d "$TARGET" ]]; then
  echo "Error: $TARGET is not a directory" >&2
  exit 1
fi

# --- helpers ---

slugify() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//'
}

pascalcase() {
  echo "$1" | sed 's/[-_]/ /g' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) substr($i,2)}1' | tr -d ' '
}

git_remote_url() {
  git -C "$1" remote get-url origin 2>/dev/null || true
}

api() {
  local method="$1" path="$2" body="${3:-}"
  local -a curl_args=(-s -w '\n%{http_code}' -X "$method" "$API_BASE$path")
  curl_args+=(-H "$AUTH_HEADER")
  if [[ -n "$body" ]]; then
    curl_args+=(-H 'Content-Type: application/json' -d "$body")
  fi
  curl "${curl_args[@]}"
}

create_project() {
  local dir="$1" parent_id="${2:-}"
  local basename
  basename="$(basename "$dir")"
  local folder
  folder="$(slugify "$basename")"
  local name
  name="$(pascalcase "$basename")"
  local repo_url
  repo_url="$(git_remote_url "$dir")"

  # Try to create via POST. Pass parentId up front so the board creates the
  # child directory and its default prompts at the final nested path.
  local resp http_code
  local create_body="{\"name\":\"$name\",\"folder\":\"$folder\""
  [[ -n "$parent_id" ]] && create_body+=",\"parentId\":\"$parent_id\""
  create_body+="}"
  resp="$(api POST /api/projects "$create_body")"
  http_code="$(echo "$resp" | tail -1)"

  local is_update=false
  if [[ "$http_code" == "409" ]]; then
    is_update=true
  elif [[ "$http_code" != "201" ]]; then
    resp="$(echo "$resp" | sed '$d')"
    echo "  FAIL creating $folder: HTTP $http_code — $resp" >&2
    return 1
  fi

  # Build settings — on update, only patch provided fields (skip stages/mode)
  local settings="{"
  local sep=""
  if [[ "$is_update" == false ]]; then
    settings+="\"mode\":\"kanban\""
    settings+=",\"stages\":[{\"id\":\"backlog\",\"title\":\"Backlog\",\"type\":\"queue\",\"color\":\"#8B8FA3\"},{\"id\":\"in_progress\",\"title\":\"In Progress\",\"type\":\"active\",\"color\":\"#3B82F6\"},{\"id\":\"completed\",\"title\":\"Completed\",\"type\":\"done\",\"color\":\"#22C55E\"},{\"id\":\"failed\",\"title\":\"Failed\",\"type\":\"queue\",\"color\":\"#EF4444\"},{\"id\":\"done\",\"title\":\"Done\",\"type\":\"done\",\"color\":\"#8B8FA3\"}]"
    sep=","
  fi
  settings+="${sep}\"repositoryLocation\":\"$dir\""
  [[ -n "$repo_url" ]] && settings+=",\"repositoryUrl\":\"$repo_url\""
  [[ -n "$DEFAULT_SANDBOX" ]] && settings+=",\"defaultSandbox\":\"$DEFAULT_SANDBOX\""
  [[ -n "$DEFAULT_SERVICE" ]] && settings+=",\"defaultSandboxService\":\"$DEFAULT_SERVICE\""
  settings+="}"

  local patch_body="{\"settings\":$settings"
  [[ -n "$parent_id" ]] && patch_body+=",\"parentId\":\"$parent_id\""
  patch_body+="}"

  resp="$(api PATCH "/api/projects/$folder" "$patch_body")"
  http_code="$(echo "$resp" | tail -1)"
  if [[ "$http_code" != "200" ]]; then
    echo "  WARN: settings update for $folder returned HTTP $http_code" >&2
  fi

  if [[ "$is_update" == true ]]; then
    echo "  updated $folder"
  else
    echo "  created $folder"
  fi
}

# --- main ---

if [[ -d "$TARGET/.git" ]]; then
  echo "Single repo: $TARGET"
  create_project "$TARGET"
else
  # Scan children for git repos
  children=()
  for child in "$TARGET"/*/; do
    [[ -d "${child}.git" ]] && children+=("${child%/}")
  done

  if [[ ${#children[@]} -eq 0 ]]; then
    echo "Error: no .git found in $TARGET or its direct children" >&2
    exit 1
  fi

  parent_folder="$(slugify "$(basename "$TARGET")")"
  parent_name="$(pascalcase "$(basename "$TARGET")")"

  echo "Parent project: $parent_name ($parent_folder)"

  # Create parent (isParent, no repo)
  resp="$(api POST /api/projects "{\"name\":\"$parent_name\",\"folder\":\"$parent_folder\"}")"
  http_code="$(echo "$resp" | tail -1)"
  if [[ "$http_code" == "409" ]]; then
    echo "  parent already exists, using it"
  elif [[ "$http_code" == "201" ]]; then
    api PATCH "/api/projects/$parent_folder" '{"settings":{"isParent":true,"mode":"chat"}}' >/dev/null
    echo "  created parent"
  else
    echo "  FAIL creating parent: HTTP $http_code" >&2
    exit 1
  fi

  echo "Child repos (${#children[@]}):"
  for child in "${children[@]}"; do
    create_project "$child" "$parent_folder"
  done
fi

echo "Done."
