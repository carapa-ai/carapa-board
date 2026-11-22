#!/usr/bin/env bash
# Remove persisted task recordings; active IPC recordings are outside this scope.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: cleanup-recordings.sh [--project FOLDER | --all] [--days N] [--apply]

  --project FOLDER   Clean one project, identified by its folder name.
  --all             Clean all projects (default).
  --days N          Remove files older than N * 24 hours (default: 3).
                    Use 0 to select all recordings regardless of age.
  --apply           Delete matching files. Without this flag, only preview.
  --help            Show this help.

Run on the host. Reads $CARAPA_DATA_DIR/groups; an exported CARAPA_DATA_DIR
overrides the value in the repository's .env (located relative to this script).
.env values are read literally, without shell expansion or execution.
Only regular recordings/task-*/*.webm files are selected, without following
symlinks. Age is measured from file modification time. IPC recordings, other
artifacts, and directories are retained. Removed recordings disappear from the
task's recording list; existing links to them will no longer work.
Requires Bash and GNU find/stat (Linux).
EOF
}

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

project=''
scope=''
days=3
apply=false
while (($#)); do
  case "$1" in
    --project|--days)
      (($# >= 2)) && [[ -n "$2" ]] || fail "Missing value for $1"
      case "$1" in
        --project)
          [[ -z "$scope" ]] || fail 'Choose either --project or --all once'
          scope=project; project=$2 ;;
        --days) days=$2 ;;
      esac
      shift 2 ;;
    --all)
      [[ -z "$scope" ]] || fail 'Choose either --project or --all once'
      scope=all; shift ;;
    --apply) apply=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

data_dir="${CARAPA_DATA_DIR-}"
if [[ ! -v CARAPA_DATA_DIR ]]; then
  repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
  if [[ -f "$repo_dir/.env" ]]; then
    # Read only this setting; never source .env as executable shell code.
    data_dir=$(sed -nE 's/^[[:space:]]*(export[[:space:]]+)?CARAPA_DATA_DIR[[:space:]]*=[[:space:]]*(.*)$/\2/p' "$repo_dir/.env" | tail -n 1)
    data_dir="${data_dir%"${data_dir##*[![:space:]]}"}"
    if [[ "$data_dir" == \"*\" || "$data_dir" == \'*\' ]]; then
      data_dir="${data_dir:1:${#data_dir}-2}"
    fi
    # Relative .env paths belong to the repository, regardless of invocation cwd.
    if [[ -n "$data_dir" && "$data_dir" != /* ]]; then data_dir="$repo_dir/$data_dir"; fi
  fi
fi
[[ -n "$data_dir" ]] || fail 'CARAPA_DATA_DIR must be set in the environment or repository .env to the host data directory'
groups_dir="$data_dir/groups"
[[ "$days" =~ ^(0|[1-9][0-9]{0,5})$ ]] || fail '--days must be an integer from 0 to 999999'
if [[ "$scope" == project ]]; then
  [[ "$project" != . && "$project" != .. && "$project" != */* ]] || fail 'Project must be a single folder name'
fi
groups_dir=$(cd -- "$groups_dir" && pwd -P) || fail 'Groups directory is inaccessible'
shopt -s nullglob dotglob
if [[ "$scope" == project ]]; then
  projects=("$groups_dir/$project")
  [[ -d "${projects[0]}" && ! -L "${projects[0]}" ]] || fail 'Project directory is missing or is a symlink'
else
  projects=("$groups_dir"/*)
fi

# Capture discovery errors before starting any deletion; NUL delimiters preserve
# spaces and newlines in filenames. Only traverse the known storage layout.
manifest=$(mktemp)
trap 'rm -f -- "$manifest"' EXIT
for project_dir in "${projects[@]}"; do
  [[ -d "$project_dir" && ! -L "$project_dir" ]] || continue
  recordings_dir="$project_dir/recordings"
  [[ -d "$recordings_dir" && ! -L "$recordings_dir" ]] || continue
  for task_dir in "$recordings_dir"/task-*; do
    [[ -d "$task_dir" && ! -L "$task_dir" ]] || continue
    find -P "$task_dir" -maxdepth 1 -type f -iname '*.webm' -print0 >> "$manifest"
  done
done

cutoff=$(($(date +%s) - days * 86400))
count=0
bytes=0
action='Would delete'
[[ "$apply" == false ]] || action='Deleted'
while IFS= read -r -d '' file; do
  [[ -f "$file" && ! -L "$file" ]] || continue
  read -r size modified < <(stat --format='%s %Y' -- "$file")
  if ((days != 0 && modified >= cutoff)); then continue; fi
  if [[ "$apply" == true ]]; then rm -- "$file"; fi
  count=$((count + 1))
  bytes=$((bytes + size))
done < "$manifest"
printf '%s: %s recording(s), %s bytes total.\n' "$action" "$count" "$bytes"
if [[ "$apply" == false ]]; then printf 'Preview only. Add --apply to delete.\n'; fi
