#!/usr/bin/env bash

set -euo pipefail

source scripts/test-file-groups.sh
. ./scripts/load-test-env.sh

test_scope="${1:-all}"
if [[ "$test_scope" != "all" && "$test_scope" != "bun" && "$test_scope" != "backend" && "$test_scope" != "ui" && "$test_scope" != "contracts" && "$test_scope" != "android" ]]; then
  echo "Usage: $0 [all|bun|backend|ui|contracts|android]" >&2
  exit 2
fi

# Bun executes test files in a shared process. Tests that install module mocks
# or intentionally change process-global auth state can therefore affect
# unrelated suites. Run those files in short-lived processes, then run the
# uncontaminated remainder once.
#
# Keep external model credentials out of the test environment.
sanitize_test_credentials

# The "bun" scope is "all" without the UI Vitest/jsdom run: every Bun-test file
# with the same process isolation, for the local `bun run test` commands.
#
# UI component behavior runs in the repository-owned Vitest/jsdom runtime.
# Android client tests also resolve dependencies from the UI installation.
if [[ "$test_scope" == "all" || "$test_scope" == "bun" || "$test_scope" == "ui" || "$test_scope" == "android" ]]; then
  if [[ ! -x ui/node_modules/.bin/vitest ]]; then
    (cd ui && bun install --frozen-lockfile --ignore-scripts)
  fi
fi
if [[ "$test_scope" == "all" || "$test_scope" == "ui" ]]; then
  # Vitest otherwise starts one worker per visible CPU. In the Docker build that
  # is the host's CPU count, shared with every parallel gate stage, and the Bun
  # image's `node` command is a Bun shim, so jsdom suites also run slower there.
  # Uncapped, they hit the 5 s test timeout. Less constrained CI hosts can opt
  # into more workers explicitly.
  ci_ui_test_workers="${CI_UI_TEST_WORKERS:-4}"
  if ! [[ "$ci_ui_test_workers" =~ ^[1-9][0-9]*$ ]]; then
    echo "CI_UI_TEST_WORKERS must be a positive integer" >&2
    exit 2
  fi
  ui_test_log="$(mktemp "${TMPDIR:-/tmp}/carapa-ui-tests.XXXXXX")"
  set +e
  (cd ui && NO_COLOR=1 FORCE_COLOR=0 bun run test "--maxWorkers=$ci_ui_test_workers") >"$ui_test_log" 2>&1
  ui_test_status=$?
  set -e
  cat "$ui_test_log"
  if ((ui_test_status != 0)); then
    ui_failure_details="$(awk '
      /^[[:space:]]*FAIL[[:space:]]/ { capture = 1 }
      capture && /^[[:space:]]*Test Files[[:space:]]/ { exit }
      capture { print }
    ' "$ui_test_log")"
    printf '\nUI test failure details (repeated for build-log visibility):\n' >&2
    if [[ -n "$ui_failure_details" ]]; then
      printf '%s\n' "$ui_failure_details" >&2
    else
      tail -80 "$ui_test_log" >&2
    fi
    rm -f -- "$ui_test_log"
    exit "$ui_test_status"
  fi
  rm -f -- "$ui_test_log"
fi

if [[ "$test_scope" == "ui" ]]; then
  for test_file in "${ci_ui_isolated_test_files[@]}"; do
    LOG_LEVEL=silent bun test --no-env-file --only-failures "$test_file"
  done
  ui_ignore_args=()
  for test_file in "${ci_ui_isolated_test_files[@]}"; do
    ui_ignore_args+=("--path-ignore-patterns=$test_file")
  done
  for test_file in "${ci_android_test_files[@]}"; do
    ui_ignore_args+=("--path-ignore-patterns=$test_file")
  done
  # Browser tests are routed by naming convention, so new suites cannot leak
  # into this ordinary UI run when someone forgets to update a file list.
  ui_ignore_args+=("--path-ignore-patterns=**/*.browser.test.ts")
  ui_ignore_args+=("--path-ignore-patterns=**/*.browser.test.tsx")
  LOG_LEVEL=silent bun test --no-env-file "${ui_ignore_args[@]}" --only-failures ui/src
  exit
fi

isolated_test_files=("${ci_backend_isolated_test_files[@]}")
if [[ "$test_scope" == "all" || "$test_scope" == "bun" ]]; then
  isolated_test_files+=("${ci_ui_isolated_test_files[@]}")
  isolated_test_files+=("${ci_contract_test_files[@]}")
  isolated_test_files+=("${ci_android_test_files[@]}")
elif [[ "$test_scope" == "contracts" ]]; then
  isolated_test_files=("${ci_contract_test_files[@]}")
elif [[ "$test_scope" == "android" ]]; then
  isolated_test_files=("${ci_android_test_files[@]}")
fi

# No source-inspection suites are excluded from the backend CI domain.
ci_excluded_test_files=()

# Most isolated suites initialize their own PGlite/WASM database. Keep the
# container-safe default low enough that concurrent database startup does not
# starve a suite and leave its freshly inserted fixtures temporarily unreadable.
# Less constrained CI hosts can opt into more parallelism explicitly.
ci_test_jobs="${CI_TEST_JOBS:-2}"
if ! [[ "$ci_test_jobs" =~ ^[1-9][0-9]*$ ]]; then
  echo "CI_TEST_JOBS must be a positive integer" >&2
  exit 2
fi
if ((ci_test_jobs > 8)); then
  ci_test_jobs=8
fi

isolated_log_dir="$(mktemp -d "${TMPDIR:-/tmp}/carapa-test-ci.XXXXXX")"
trap 'rm -rf -- "$isolated_log_dir"' EXIT

# Each suite still gets its own Bun process, but independent processes can run
# concurrently. xargs returns a failure when any child fails, preserving the
# deploy gate while avoiding repeated PGlite startup on the critical path.
# Successful suites stay silent; retaining only a failed suite's named output
# prevents parallel pass summaries from pushing the actionable error out of
# administrator build logs.
printf '%s\0' "${isolated_test_files[@]}" | xargs -0 -n 1 -P "$ci_test_jobs" \
  bash -c '
    log_dir="$1"
    test_file="$2"
    log_file="$log_dir/${test_file//\//_}.log"
    LOG_LEVEL=silent bun test --no-env-file "$test_file" --timeout 30000 --only-failures >"$log_file" 2>&1 || {
      status=$?
      printf "Isolated test failed: %s\n" "$test_file" >&2
      cat "$log_file" >&2
      exit "$status"
    }
    # Report the executed count so verify.sh can include isolated suites.
    grep -E "^Ran [0-9]+ tests?" "$log_file" || true
    rm -f -- "$log_file"
  ' _ "$isolated_log_dir"

if [[ "$test_scope" == "contracts" || "$test_scope" == "android" ]]; then
  exit
fi

test_roots=()
if [[ "$test_scope" == "backend" ]]; then
  # Bun treats positional arguments as substring filters, so the filter `src`
  # also matches `ui/src`. Pass every backend test file explicitly to make UI
  # discovery structurally impossible while retaining tests under scripts/.
  test_roots=(src scripts)
else
  test_roots=(src scripts ui)
fi
backend_args=()
for test_file in "${isolated_test_files[@]}"; do
  backend_args+=(--exclude "$test_file")
done
for test_file in "${ci_excluded_test_files[@]}"; do
  backend_args+=(--exclude "$test_file")
done
for test_file in "${ci_contract_test_files[@]}"; do
  backend_args+=(--exclude "$test_file")
done
for test_file in "${ci_android_test_files[@]}"; do
  backend_args+=(--exclude "$test_file")
done
bash scripts/test-ci-backend.sh "${backend_args[@]}" -- "${test_roots[@]}"
