#!/usr/bin/env bash

set -euo pipefail

source scripts/test-file-groups.sh
. ./scripts/load-test-env.sh
sanitize_test_credentials

if (($# == 0)); then
  echo "Usage: $0 TEST_FILE ..." >&2
  exit 2
fi

declare -A isolation_path=()
for test_file in "${ci_isolated_test_files[@]}"; do
  isolation_path["${test_file#./}"]="$test_file"
done

isolated_files=()
ordinary_files=()
for test_file in "$@"; do
  if [[ -n "${isolation_path[${test_file#./}]:-}" ]]; then
    isolated_files+=("${isolation_path[${test_file#./}]}")
  else
    ordinary_files+=("$test_file")
  fi
done

# Run isolated files first so any process-global replacement is guaranteed to
# disappear before the ordinary batch starts.
for test_file in "${isolated_files[@]}"; do
  LOG_LEVEL=silent bun test --no-env-file --timeout 30000 --only-failures "$test_file" || {
    status=$?
    printf 'Selected isolated test failed: %s\n' "$test_file" >&2
    exit "$status"
  }
done

if ((${#ordinary_files[@]})); then
  LOG_LEVEL=silent bun test --no-env-file --timeout 30000 --only-failures "${ordinary_files[@]}" || {
    status=$?
    printf 'Selected ordinary test batch failed:' >&2
    printf ' %s' "${ordinary_files[@]}" >&2
    printf '\n' >&2
    exit "$status"
  }
fi
