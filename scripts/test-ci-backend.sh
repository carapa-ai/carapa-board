#!/usr/bin/env bash

set -euo pipefail

source scripts/test-file-groups.sh
. ./scripts/load-test-env.sh
sanitize_test_credentials

# Ordinary suites share each Bun process. Three shards keep the slowest batch
# close to the isolated-suite wall time without increasing measured peak RSS
# over the previous two-shard default. Constrained hosts may select 1-8 batched
# processes with CI_TEST_SHARDS; this does not change the isolated-suite limit.
shard_count="${CI_TEST_SHARDS:-3}"
if ! [[ "$shard_count" =~ ^[1-9][0-9]*$ ]] || ((shard_count > 8)); then
  echo "CI_TEST_SHARDS must be an integer between 1 and 8" >&2
  exit 2
fi

declare -A excluded=()
while (($# > 0)) && [[ "$1" == "--exclude" ]]; do
  if (($# < 2)); then
    echo "--exclude requires a test file" >&2
    exit 2
  fi
  excluded["${2#./}"]=1
  shift 2
done
if (($# == 0)) || [[ "$1" != "--" ]]; then
  echo "Usage: $0 [--exclude FILE ...] -- ROOT ..." >&2
  exit 2
fi
shift
if (($# == 0)); then
  echo "At least one test root is required" >&2
  exit 2
fi

# Discover once, sort for reproducibility, and then assign by index. Round
# robin keeps shard file counts within one while batching many files per Bun.
test_files=()
while IFS= read -r -d '' test_file; do
  test_file="${test_file#./}"
  # Browser suites own Vite/Playwright process trees and must only run through
  # scripts/test-browser.sh, which serializes and reaps them. Keep this
  # structural instead of relying on a manually maintained exclusion list: a
  # newly added *.browser.test.ts file must never enter ordinary CI shards.
  case "$test_file" in
    *.browser.test.ts|*.browser.test.tsx) continue ;;
  esac
  [[ -n "${excluded[$test_file]:-}" ]] || test_files+=("$test_file")
done < <(
  find "$@" -type f \
    \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.spec.ts' -o -name '*.spec.tsx' \) \
    -print0 | sort -z
)

if ((${#test_files[@]} == 0)); then
  echo "No ordinary backend test files discovered" >&2
  exit 2
fi

log_dir="${CI_TEST_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/carapa-test-shards.XXXXXX")}"
if [[ -z "${CI_TEST_LOG_DIR:-}" ]]; then
  trap 'rm -rf -- "$log_dir"' EXIT
else
  mkdir -p "$log_dir"
fi

pids=()
for ((shard = 0; shard < shard_count; shard++)); do
  shard_files=()
  for ((index = shard; index < ${#test_files[@]}; index += shard_count)); do
    shard_files+=("${test_files[$index]}")
  done
  ((${#shard_files[@]} > 0)) || continue
  LOG_LEVEL=silent bun test --no-env-file --timeout 30000 --only-failures "${shard_files[@]}" \
    >"$log_dir/shard-$((shard + 1)).log" 2>&1 &
  pids+=("$!")
done

status=0
for ((shard = 0; shard < ${#pids[@]}; shard++)); do
  shard_status=0
  wait "${pids[$shard]}" || shard_status=$?
  cat "$log_dir/shard-$((shard + 1)).log"
  if ((shard_status != 0)); then
    status=$shard_status
  fi
done

if ((status != 0)); then
  echo "Ordinary backend failing tests:" >&2
  for ((shard = 0; shard < ${#pids[@]}; shard++)); do
    awk '/\.(test|spec)\.tsx?:$/ { test_file=$0 } /^\(fail\)/ { if (test_file != "") print test_file; print }' \
      "$log_dir/shard-$((shard + 1)).log" >&2
  done
fi
exit "$status"
