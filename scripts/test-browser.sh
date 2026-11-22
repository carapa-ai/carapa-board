#!/usr/bin/env bash

set -euo pipefail

. ./scripts/load-test-env.sh

if ! command -v playwright-cli >/dev/null 2>&1; then
  echo "playwright-cli is required for the dedicated browser test suite" >&2
  exit 127
fi

if (($#)); then
  browser_test_files=("$@")
  for test_file in "${browser_test_files[@]}"; do
    case "$test_file" in
      ui/src/*.browser.test.ts|ui/src/*.browser.test.tsx|\
      ui/src/**/*.browser.test.ts|ui/src/**/*.browser.test.tsx) ;;
      *)
        printf 'Not a browser test: %s\n' "$test_file" >&2
        exit 2
        ;;
    esac
    [[ -f "$test_file" ]] || {
      printf 'Browser test not found: %s\n' "$test_file" >&2
      exit 2
    }
  done
else
  # The complete dedicated gate also verifies its runtime allocator contract.
  (cd ui && bun run test:browser-runtime)
  mapfile -d '' browser_test_files < <(
    find ui/src -type f \
      \( -name '*.browser.test.ts' -o -name '*.browser.test.tsx' \) \
      -print0 | LC_ALL=C sort -z
  )
fi

if ((${#browser_test_files[@]} == 0)); then
  echo "No browser test suites discovered" >&2
  exit 2
fi

active_group=""
reap_active_group() {
  [[ -n "$active_group" ]] || return 0
  # Each suite is a session/process-group leader. Always signal the complete
  # group after Bun exits: a failed afterAll must not leave Vite, esbuild, or
  # Chromium descendants alive for the next suite.
  kill -TERM -- "-$active_group" 2>/dev/null || true
  sleep 0.2
  kill -KILL -- "-$active_group" 2>/dev/null || true
  wait "$active_group" 2>/dev/null || true
  active_group=""
}
trap reap_active_group EXIT
# Convert interrupts into a normal shell exit so the EXIT trap always reaps
# the active process group before preserving the conventional signal status.
trap 'exit 130' INT
trap 'exit 143' TERM

# Browser suites are intentionally serial. Each may own a complete disposable
# Board, Vite, simulator, and Chromium tree; running files together lets Bun's
# file concurrency multiply those trees past the sandbox memory limit.
for test_file in "${browser_test_files[@]}"; do
  setsid env LOG_LEVEL=silent bun test --no-env-file --only-failures "$test_file" &
  active_group=$!
  status=0
  wait "$active_group" || status=$?
  reap_active_group
  ((status == 0)) || exit "$status"
done
