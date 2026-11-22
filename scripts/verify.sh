#!/usr/bin/env bash
# Run the local, non-interactive validation gates used by coding agents.
# Optional arguments are forwarded to Bun's test runner for a targeted run.

set -euo pipefail

source scripts/test-file-groups.sh
sanitize_test_credentials

worktree_root="$(pwd -P)"
worktree_key="$(printf '%s' "$worktree_root" | cksum | awk '{print $1}')"
verify_lock="${TMPDIR:-/tmp}/carapa-verify-${worktree_key}.lock"
if [[ "${CARAPA_VERIFY_LOCK_HELD:-0}" != 1 ]]; then
  exec 9>"$verify_lock"
  flock 9
  export CARAPA_VERIFY_LOCK_HELD=1
fi

verify_log="$(mktemp "${TMPDIR:-/tmp}/carapa-verify.XXXXXX")"
related_log=""
active_phase_pids=()
phase_logs=()
phase_status_files=()
timing_log="$(mktemp "${TMPDIR:-/tmp}/carapa-verify-timing.XXXXXX")"
verify_started_at="$(date +%s%N)"
tests_executed=0
browser_tests_executed=0
browser_phase_ran=0
verify_stamp_file=""

add_bun_test_count() {
  local log_file="$1"
  local count
  count="$(awk '/^Ran [0-9]+ tests?/ { total += $2 } END { print total + 0 }' "$log_file")"
  tests_executed=$((tests_executed + count))
}

add_vitest_text_count() {
  local log_file="$1"
  local count
  count="$(awk '/^[[:space:]]*Tests[[:space:]]+[0-9]+/ { total += $2 } END { print total + 0 }' "$log_file")"
  tests_executed=$((tests_executed + count))
}
add_browser_test_count() {
  local log_file="$1"
  local count
  count="$(awk '/^Ran [0-9]+ tests?/ { total += $2 } END { print total + 0 }' "$log_file")"
  browser_tests_executed=$((browser_tests_executed + count))
  tests_executed=$((tests_executed + count))
}

run_full_ui_tests() {
  run_phase "UI tests" bash scripts/test-ci.sh ui
  add_bun_test_count "$verify_log"
  add_vitest_text_count "$verify_log"
}

cleanup_phase_children() {
  local pid

  # Each phase is the leader of its own session/process group (created with
  # setsid below). Kill the group, not just the shell that launched it, so a
  # nested bun/npm process cannot outlive this verifier and retain fd 9.
  for pid in "${active_phase_pids[@]}"; do
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 0.1
  for pid in "${active_phase_pids[@]}"; do
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  done
  for pid in "${active_phase_pids[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
  active_phase_pids=()
}

cleanup_verify_files() {
  local exit_status=$?
  cleanup_phase_children
  # A run that did not pass must never leave an earlier pass behind to be reused.
  if (( exit_status != 0 )) && [[ -n "$verify_stamp_file" ]]; then
    rm -f -- "$verify_stamp_file"
  fi
  rm -f -- "$verify_log" "$related_log" "$timing_log" "${phase_logs[@]}" "${phase_status_files[@]}"
}

trap cleanup_verify_files EXIT

run_phase() {
  local phase="$1"
  local status
  local started_at
  local finished_at
  shift

  started_at="$(date +%s%N)"
  set +e
  "$@" >"$verify_log" 2>&1
  status=$?
  set -e
  finished_at="$(date +%s%N)"
  printf '%s\t%s\t%s\n' "$phase" "$started_at" "$finished_at" >>"$timing_log"

  if (( status != 0 )); then
    printf 'Verification failed: %s\n' "$phase" >&2
    cat "$verify_log" >&2
    return "$status"
  fi
}

# These gates only read the checkout, so they can overlap. Keep this fan-out
# deliberately bounded at three processes: tests retain their existing Bun
# and PGlite parallelism, and the memory-heavy UI build stays after the test
# and static-gate barriers.
run_concurrent_phases() {
  local phase command status index
  local -a phase_names=() phase_commands=()

  while (( $# )); do
    phase_names+=("$1")
    phase_commands+=("$2")
    shift 2
  done

  phase_logs=()
  phase_status_files=()
  active_phase_pids=()
  for index in "${!phase_names[@]}"; do
    phase_logs+=("$(mktemp "${TMPDIR:-/tmp}/carapa-verify-phase.XXXXXX")")
    phase_status_files+=("$(mktemp "${TMPDIR:-/tmp}/carapa-verify-status.XXXXXX")")
    phase="${phase_names[$index]}"
    command="${phase_commands[$index]}"
    # setsid makes the tracked PID the session/process-group leader. The
    # command wrapper records status without changing the gate's exit code.
    setsid bash -c '
      set +e
      started_at="$(date +%s%N)"
      bash -c "$1"
      status=$?
      finished_at="$(date +%s%N)"
      printf "%s %s %s\n" "$status" "$started_at" "$finished_at" >"$2"
      exit "$status"
    ' phase-runner "$command" "${phase_status_files[$index]}" \
      >"${phase_logs[$index]}" 2>&1 &
    active_phase_pids+=("$!")
  done

  local first_failure=0
  for index in "${!phase_names[@]}"; do
    set +e
    wait "${active_phase_pids[$index]}"
    status=$?
    set -e
    if (( status != 0 && first_failure == 0 )); then
      first_failure=$status
    fi
  done

  # Report in declaration order after every child has finished, so failures
  # are complete and stable regardless of which process exits first.
  for index in "${!phase_names[@]}"; do
    if [[ -s "${phase_status_files[$index]}" ]]; then
      read -r status started_at finished_at <"${phase_status_files[$index]}"
      printf '%s\t%s\t%s\n' "${phase_names[$index]}" "$started_at" "$finished_at" >>"$timing_log"
    else
      status=1
    fi
    if (( status != 0 )); then
      printf 'Verification failed: %s\n' "${phase_names[$index]}" >&2
      cat "${phase_logs[$index]}" >&2
    fi
  done

  active_phase_pids=()
  if (( first_failure != 0 )); then
    return "$first_failure"
  fi
}

changed_backend_tests=0
backend_full_suite=0
backend_changed_files=()
backend_changed_statuses=()
backend_selected_tests=()
backend_selection_reason=""
changed_format_files=()
changed_ui_tests=0
changed_ui_full_suite=0
changed_browser_tests=()
run_backend_static=1
run_ui_static=1
run_android_guard=1
verify_mode="full"
comparison_ref="HEAD"
comparison_ref_valid=1
comparison_ref_source="default"
resolved_head=""
verification_skip_reason=""
default_branch="${DEFAULT_BRANCH:-develop}"
group_fs_allowlist="scripts/group-fs-allowlist.json"

resolve_worktree_base() {
  local default_branch_tip
  if default_branch_tip="$(git rev-parse --verify "refs/heads/${default_branch}^{commit}" 2>/dev/null)" || \
     default_branch_tip="$(git rev-parse --verify "refs/remotes/origin/${default_branch}^{commit}" 2>/dev/null)"; then
    git merge-base "$default_branch_tip" HEAD 2>/dev/null
  else
    return 1
  fi
}

is_shared_input() {
  case "$1" in
    src/types.ts|ui/src/types.ts|ui/src/lib/api.ts|\
    src/db/schema.ts|src/test-preload.ts|\
    package.json|bun.lock*|package-lock.json|ui/package.json|ui/package-lock.json|\
    ui/bun.lock*|ui/pnpm-lock.yaml|ui/yarn.lock|bunfig.toml|tsconfig*.json|\
    ui/tsconfig*.json|scripts/verify*|scripts/test-ci*|scripts/test-ownership*|ui/vite.config.*|\
    ui/vitest.config.*|ui/src/test/*|ui/src/setup*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_backend_input() {
  [[ "$1" == src/* ]]
}

# Restrict this to documentation locations. Markdown prompts, executable skill
# helpers, and arbitrary YAML/configuration can affect behavior and stay gated.
is_documentation_input() {
  case "$1" in
    README.md|.env.example|AGENTS.md|CLAUDE.md|GEMINI.md|CONTRIBUTING.md|CHANGELOG.md|\
    LICENSE|LICENSE.md|SECURITY.md|docs/*.md|.agent/rules/*.md|.claude/rules/*.md)
      return 0
      ;;
    .agent/skills/*|.agents/skills/*|.claude/skills/*|.codex/skills/*)
      case "$1" in
        */SKILL.md|*/references/*.md|*/assets/*.md|*/agents/openai.yaml)
          return 0
          ;;
      esac
      ;;
  esac
  return 1
}

is_documentation_change() {
  local status=$1 source=$2 destination=${3:-}
  [[ "$status" != U* ]] && is_documentation_input "$source" || return 1
  if [[ "$status" == R* || "$status" == C* ]]; then
    is_documentation_input "$destination" || return 1
  fi
}

is_dedicated_browser_input() {
  case "$1" in
    scripts/ui-sandbox/*|\
    ui/src/*.browser.test.ts|ui/src/*.browser.test.tsx|\
    ui/src/**/*.browser.test.ts|ui/src/**/*.browser.test.tsx)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_android_input() {
  case "$1" in
    ui/android/*|ui/capacitor.config.*|ui/patches/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

enable_conservative_verification() {
  changed_backend_tests=1
  backend_full_suite=1
  changed_ui_tests=1
  changed_ui_full_suite=1
  changed_browser_tests=()
  run_backend_static=1
  run_ui_static=1
  run_android_guard=1
}

classify_changed_inputs() {
  local diff_output
  local untracked_output
  local changed_file_status
  local file
  local path
  local saw_input=0
  local saw_behavioral_input=0

  # An invalid base or failed diff inspection is uncertainty, not an empty diff.
  # Keep both domains enabled unless inspection succeeds.
  enable_conservative_verification
  if (( ! comparison_ref_valid )); then
    return
  fi
  if ! diff_output="$(git diff --name-status "$comparison_ref" --)" || \
     ! untracked_output="$(git ls-files --others --exclude-standard)"; then
    return
  fi

  changed_backend_tests=0
  backend_full_suite=0
  backend_changed_files=()
  backend_changed_statuses=()
  changed_ui_tests=0
  changed_ui_full_suite=0
  run_backend_static=0
  run_ui_static=0
  run_android_guard=0
  while IFS=$'\t' read -r changed_file_status file path; do
    [[ -n "$file" ]] || continue
    saw_input=1
    if is_documentation_change "$changed_file_status" "$file" "$path"; then
      continue
    fi
    saw_behavioral_input=1
    if is_dedicated_browser_input "$file"; then
      if [[ "$file" == ui/src/*.browser.test.ts || "$file" == ui/src/*.browser.test.tsx || \
        "$file" == ui/src/**/*.browser.test.ts || "$file" == ui/src/**/*.browser.test.tsx ]]; then
        changed_browser_tests+=("$file")
      fi
      continue
    fi
    # Backend production renames/deletions can stay targeted when ownership is
    # known. Other destructive or unresolved changes retain the broad fallback.
    if [[ "$changed_file_status" == R* || "$changed_file_status" == C* ]]; then
      if is_backend_input "$file" && is_backend_input "$path" && \
         ! is_shared_input "$file" && ! is_shared_input "$path"; then
        changed_backend_tests=1
        run_backend_static=1
        backend_changed_statuses+=("$changed_file_status" "$changed_file_status")
        backend_changed_files+=("$file" "$path")
      else
        enable_conservative_verification
      fi
      continue
    fi
    if [[ "$changed_file_status" == D* ]] && is_backend_input "$file" && \
       ! is_shared_input "$file"; then
      changed_backend_tests=1
      run_backend_static=1
      backend_changed_statuses+=("$changed_file_status")
      backend_changed_files+=("$file")
      continue
    fi
    if [[ "$changed_file_status" == U* ]]; then
      enable_conservative_verification
      continue
    fi
    if is_shared_input "$file"; then
      enable_conservative_verification
    elif [[ "$file" == "$group_fs_allowlist" && "$changed_file_status" != D* ]]; then
      # Only scripts/check-group-fs.ts reads the allowlist: rerun static phases.
      run_backend_static=1
    elif [[ "$file" == ui/* ]]; then
      run_ui_static=1
      changed_ui_tests=1
      if is_android_input "$file"; then
        run_android_guard=1
      fi
      add_ui_source_sibling_browser_tests "$file" "$changed_file_status"
    elif is_backend_input "$file"; then
      changed_backend_tests=1
      run_backend_static=1
      backend_changed_statuses+=("$changed_file_status")
      backend_changed_files+=("$file")
    else
      # Unknown repository paths may affect either runner.
      enable_conservative_verification
    fi
  done <<< "$diff_output"

  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    saw_input=1
    if is_documentation_input "$file"; then
      continue
    fi
    saw_behavioral_input=1
    if is_dedicated_browser_input "$file"; then
      if [[ "$file" == ui/src/*.browser.test.ts || "$file" == ui/src/*.browser.test.tsx || \
        "$file" == ui/src/**/*.browser.test.ts || "$file" == ui/src/**/*.browser.test.tsx ]]; then
        changed_browser_tests+=("$file")
      fi
      continue
    fi
    if is_shared_input "$file"; then
      enable_conservative_verification
    elif [[ "$file" == "$group_fs_allowlist" ]]; then
      run_backend_static=1
    elif [[ "$file" == ui/* ]]; then
      run_ui_static=1
      changed_ui_tests=1
      if is_android_input "$file"; then
        run_android_guard=1
      fi
      add_ui_source_sibling_browser_tests "$file"
    elif is_backend_input "$file"; then
      changed_backend_tests=1
      run_backend_static=1
      backend_changed_statuses+=("A")
      backend_changed_files+=("$file")
    else
      enable_conservative_verification
    fi
  done <<< "$untracked_output"

  if (( ! saw_input )); then
    verification_skip_reason="no changed files"
  elif (( ! saw_behavioral_input )); then
    verification_skip_reason="documentation/instructions only"
  fi
}

is_prettier_input() {
  case "$1" in
    *.js|*.cjs|*.mjs|*.ts|*.cts|*.mts|*.jsx|*.tsx|*.json|*.jsonc|*.css|*.scss|*.md|*.yaml|*.yml)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# Build an argv-safe, de-duplicated list for the mutating changed-files
# formatter. Full verification remains read-only and uses format:check.
collect_changed_format_files() {
  local diff_output untracked_output status file destination
  local -A selected=()
  changed_format_files=()
  if (( ! comparison_ref_valid )); then
    return 0
  fi
  if ! diff_output="$(git diff --name-status "$comparison_ref" --)" || \
     ! untracked_output="$(git ls-files --others --exclude-standard)"; then
    return
  fi
  while IFS=$'\t' read -r status file destination; do
    [[ -n "$file" ]] || continue
    if [[ "$status" == R* || "$status" == C* ]]; then
      file="$destination"
    elif [[ "$status" == D* || "$status" == U* ]]; then
      continue
    fi
    if is_prettier_input "$file"; then
      selected["$file"]=1
    fi
  done <<< "$diff_output"
  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    if is_prettier_input "$file"; then
      selected["$file"]=1
    fi
  done <<< "$untracked_output"
  if ((${#selected[@]})); then
    mapfile -t changed_format_files < <(
      printf '%s\n' "${!selected[@]}" | LC_ALL=C sort
    )
  fi
}

# A tracked TypeScript edit that changes only ordinary comments or formatting
# cannot affect types, runtime behavior, tests, or the production build. Keep
# directive comments conservative because compilers and tooling may interpret
# them even though they are absent from the emitted syntax tree.
is_semantic_noop_change() {
  local diff_output untracked_output status file destination
  local -a files=()
  (( comparison_ref_valid )) || return 1
  diff_output="$(git diff --name-status "$comparison_ref" --)" || return 1
  untracked_output="$(git ls-files --others --exclude-standard)" || return 1
  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    is_documentation_input "$file" || return 1
  done <<< "$untracked_output"
  while IFS=$'\t' read -r status file destination; do
    [[ -n "$file" ]] || continue
    if is_documentation_change "$status" "$file" "$destination"; then
      continue
    fi
    [[ "$status" == M ]] || return 1
    case "$file" in
      *.ts|*.tsx) files+=("$file") ;;
      *) return 1 ;;
    esac
  done <<< "$diff_output"
  ((${#files[@]} > 0)) || return 1
  bun scripts/verify-semantic-noop.ts "$comparison_ref" "${files[@]}"
}

is_backend_test_file() {
  case "$1" in
    *.test.ts|*.test.tsx|*.spec.ts|*.spec.tsx) return 0 ;;
    *) return 1 ;;
  esac
}

prepare_backend_tests() {
  if (( ! changed_backend_tests )); then
    return 0
  fi
  backend_selected_tests=()
  if (( backend_full_suite )); then
    backend_selection_reason="infrastructure or ambiguous input"
    printf 'Backend tests: full domain selected (%s)\n' "$backend_selection_reason"
    return
  fi

  local index status file stem candidate manifest_source manifest_tests owned_test
  local selected_changed=0 selected_colocated=0 selected_explicit=0 unmapped=0
  local importer_selected=0 hub_files=0 importer_test importer_output
  local -a importer_tests=()
  local importer_hub_limit=12
  local ownership_file="scripts/test-ownership.tsv"
  declare -A selected=()
  for index in "${!backend_changed_files[@]}"; do
    status="${backend_changed_statuses[$index]}"
    file="${backend_changed_files[$index]}"
    if is_backend_test_file "$file"; then
      if [[ "$status" == D* ]]; then
        backend_full_suite=1
        backend_selection_reason="deleted test file"
        break
      fi
      selected["$file"]=1
      selected_changed=1
      continue
    fi

    local found_owner=0
    stem="${file%.*}"
    for candidate in \
      "$stem.test.ts" "$stem.test.tsx" "$stem.spec.ts" "$stem.spec.tsx"; do
      if [[ -f "$candidate" ]]; then
        selected["$candidate"]=1
        selected_colocated=1
        found_owner=1
      fi
    done
    while IFS=$'\t' read -r manifest_source manifest_tests; do
      [[ -n "$manifest_source" && "$manifest_source" != \#* ]] || continue
      [[ "$manifest_source" == "$file" ]] || continue
      for owned_test in $manifest_tests; do
        if [[ ! -f "$owned_test" ]]; then
          backend_full_suite=1
          backend_selection_reason="stale explicit ownership"
          break 3
        fi
        selected["$owned_test"]=1
        selected_explicit=1
        found_owner=1
      done
    done <"$ownership_file"
    if (( ! found_owner )); then
      if [[ "$status" == D* || "$status" == R* || "$status" == C* ]]; then
        backend_full_suite=1
        backend_selection_reason="unmapped destructive production change"
        break
      fi
      if ! importer_output="$(bun scripts/verify-importers.ts "$file")"; then
        backend_full_suite=1
        backend_selection_reason="importer scan failed"
        break
      fi
      importer_tests=()
      if [[ -n "$importer_output" ]]; then
        mapfile -t importer_tests <<< "$importer_output"
      fi
      if ((${#importer_tests[@]} > importer_hub_limit)); then
        hub_files=$((hub_files + 1))
      elif ((${#importer_tests[@]} > 0)); then
        for importer_test in "${importer_tests[@]}"; do
          if [[ -z "${selected[$importer_test]:-}" ]]; then
            selected["$importer_test"]=1
            importer_selected=$((importer_selected + 1))
          fi
        done
      else
        unmapped=$((unmapped + 1))
      fi
    fi
  done

  if (( backend_full_suite )); then
    backend_selected_tests=()
    printf 'Backend tests: full domain selected (%s)\n' "$backend_selection_reason"
    return
  fi
  if ((${#selected[@]})); then
    mapfile -t backend_selected_tests < <(
      printf '%s\n' "${!selected[@]}" | LC_ALL=C sort
    )
  fi
  if (( selected_explicit )); then
    backend_selection_reason="explicit ownership"
  elif (( selected_colocated )); then
    backend_selection_reason="colocated ownership"
  elif (( selected_changed )); then
    backend_selection_reason="changed test files"
  elif (( importer_selected )); then
    backend_selection_reason="direct importers"
  else
    backend_selection_reason="no owned tests; exhaustive coverage remains in CI"
  fi
  if (( importer_selected > 0 )); then
    backend_selection_reason+="; $importer_selected importer-selected"
  fi
  if (( hub_files > 0 )); then
    backend_selection_reason+="; $hub_files hub file(s) left to CI"
  fi
  if (( unmapped > 0 && ${#backend_selected_tests[@]} > 0 )); then
    backend_selection_reason+="; $unmapped unmapped production file(s)"
  fi
  printf 'Backend tests: %d files selected (%s)\n' \
    "${#backend_selected_tests[@]}" "$backend_selection_reason"
}

run_backend_tests() {
  if (( changed_backend_tests )); then
    if (( backend_full_suite )); then
      run_phase "Backend tests" bun run test:ci:backend
      add_bun_test_count "$verify_log"
      # test:ci:backend excludes the CI contract tests; the Docker build runs
      # them separately, so the full-suite fallback must run them too.
      run_phase "Contract tests" bun run test:ci:contracts
      add_bun_test_count "$verify_log"
    elif ((${#backend_selected_tests[@]})); then
      run_phase "Backend tests" bash scripts/test-bun-selected.sh "${backend_selected_tests[@]}"
      add_bun_test_count "$verify_log"
    fi
  fi
}

# Prints the existing sibling test files owned by a UI source stem (stem
# relative to ui/): the exact `<stem>.<kind>.{ts,tsx}` candidates plus
# prefix-named siblings `<stem>-*.<kind>.{ts,tsx}`, all as ui/-prefixed paths.
ui_stem_sibling_test_files() {
  local stem="$1" kind="$2"
  local candidate
  for candidate in \
    "ui/$stem.$kind.ts" "ui/$stem.$kind.tsx" \
    "ui/$stem"-*."$kind".ts "ui/$stem"-*."$kind".tsx; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
    fi
  done
}

# Selects vitest files owned by a UI source stem (relative to ui/): the exact
# `<stem>.vitest.*` candidates plus prefix-named siblings `<stem>-*.vitest.*`.
# Writes into the caller's `selected_vitest` map.
select_ui_stem_vitest_files() {
  local stem="$1"
  local candidate
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    selected_vitest["${candidate#ui/}"]=1
  done < <(ui_stem_sibling_test_files "$stem" vitest)
}

# Maps a changed (added/modified/untracked) UI source file to its sibling
# browser harness tests in the same directory, mirroring the vitest stem rule:
# `<stem>.browser.test.{ts,tsx}` plus prefix-named `<stem>-*.browser.test.{ts,tsx}`.
# Appends them to `changed_browser_tests`; run_browser_tests deduplicates.
# Deleted sources map nothing, and a sibling that no longer exists on disk is
# skipped, so a missing sibling never fails the gate.
add_ui_source_sibling_browser_tests() {
  local file="$1" status="${2:-A}"
  case "$file" in
    ui/src/*.ts|ui/src/*.tsx) ;;
    *) return 0 ;;
  esac
  [[ "$status" != D* ]] || return 0
  local stem="${file#ui/}"
  stem="${stem%.*}"
  local candidate
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    changed_browser_tests+=("$candidate")
  done < <(ui_stem_sibling_test_files "$stem" browser.test)
}

run_ui_tests() {
  if [[ "$verify_mode" != "changed" ]]; then
    run_full_ui_tests
    return
  fi

  local -a ui_vitest_files=()
  local -a ui_bun_files=()
  local -A selected_vitest=()
  local -A selected_bun=()
  local file
  local ui_file
  local stem
  local candidate
  if (( ! changed_ui_tests )); then
    return
  fi
  if (( changed_ui_full_suite )); then
    run_full_ui_tests
    return
  fi
  # A failure to inspect the diff is treated conservatively: the UI suite is
  # still a required gate, even when changed-test selection is unavailable.
  local diff_output
  if ! diff_output="$(git diff --name-status "$comparison_ref" --)"; then
    run_full_ui_tests
    return
  fi
  while IFS=$'\t' read -r changed_file_status file; do
    [[ -n "$file" ]] || continue
    if [[ "$changed_file_status" == R* || "$changed_file_status" == C* ]]; then
      # Renames and copies have two paths. Treating them as global below keeps
      # selection conservative without attempting to infer the destination.
      run_full_ui_tests
      return
    fi
    [[ "$file" == ui/* ]] || continue
    if [[ "$file" == ui/* ]]; then
      if [[ "$changed_file_status" == D* || "$changed_file_status" == U* ]]; then
        run_full_ui_tests
        return
      fi
      ui_file="${file#ui/}"
      case "$ui_file" in
        package.json|package-lock.json|bun.lock|pnpm-lock.yaml|yarn.lock|\
        vite.config.*|vitest.config.*|tsconfig*.json|src/test/*)
          run_full_ui_tests
          return
          ;;
        *.browser.test.ts|*.browser.test.tsx) ;;
        *.vitest.ts|*.vitest.tsx) selected_vitest["$ui_file"]=1 ;;
        *.test.ts|*.test.tsx|*.spec.ts|*.spec.tsx)
          selected_bun["ui/$ui_file"]=1
          ;;
        *)
          stem="${ui_file%.*}"
          select_ui_stem_vitest_files "$stem"
          for candidate in \
            "$stem.test.ts" "$stem.test.tsx" "$stem.spec.ts" "$stem.spec.tsx"; do
            [[ -f "ui/$candidate" ]] && selected_bun["ui/$candidate"]=1
          done
          ;;
      esac
    fi
  done <<< "$diff_output"

  # Include untracked UI files, which are not reported by `git diff <base>`.
  local untracked_output
  if ! untracked_output="$(git ls-files --others --exclude-standard)"; then
    run_full_ui_tests
    return
  fi
  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    [[ "$file" == ui/* ]] || continue
    if [[ "$file" == ui/* ]]; then
      ui_file="${file#ui/}"
      case "$ui_file" in
        package.json|package-lock.json|bun.lock|pnpm-lock.yaml|yarn.lock|\
        vite.config.*|vitest.config.*|tsconfig*.json|src/test/*)
          run_full_ui_tests
          return
          ;;
        *.browser.test.ts|*.browser.test.tsx) ;;
        *.vitest.ts|*.vitest.tsx) selected_vitest["$ui_file"]=1 ;;
        *.test.ts|*.test.tsx|*.spec.ts|*.spec.tsx)
          selected_bun["ui/$ui_file"]=1
          ;;
        *)
          stem="${ui_file%.*}"
          select_ui_stem_vitest_files "$stem"
          for candidate in \
            "$stem.test.ts" "$stem.test.tsx" "$stem.spec.ts" "$stem.spec.tsx"; do
            [[ -f "ui/$candidate" ]] && selected_bun["ui/$candidate"]=1
          done
          ;;
      esac
    fi
  done <<< "$untracked_output"

  if ((${#selected_vitest[@]})); then
    mapfile -t ui_vitest_files < <(
      printf '%s\n' "${!selected_vitest[@]}" | LC_ALL=C sort
    )
  fi
  if ((${#selected_bun[@]})); then
    mapfile -t ui_bun_files < <(
      printf '%s\n' "${!selected_bun[@]}" | LC_ALL=C sort
    )
  fi
  if ((${#ui_bun_files[@]})); then
    run_phase "UI Bun tests" bash scripts/test-bun-selected.sh "${ui_bun_files[@]}"
    add_bun_test_count "$verify_log"
  fi
  if ((${#ui_vitest_files[@]} == 0)); then
    return
  fi

  related_log="$(mktemp "${TMPDIR:-/tmp}/carapa-ui-related.XXXXXX")"
  local related_started_at
  local related_finished_at
  related_started_at="$(date +%s%N)"
  set +e
  (cd ui && npm exec vitest -- run --reporter=json --passWithNoTests "${ui_vitest_files[@]}") >"$related_log" 2>&1
  local related_status=$?
  set -e
  related_finished_at="$(date +%s%N)"
  printf '%s\t%s\t%s\n' "UI selected tests" "$related_started_at" "$related_finished_at" >>"$timing_log"
  if (( related_status != 0 )); then
    printf 'Verification failed: UI component tests\n' >&2
    cat "$related_log" >&2
    rm -f -- "$related_log"
    return "$related_status"
  fi
  # A successful command is not enough: require parseable Vitest JSON with a
  # positive suite count. Empty, malformed, or schema-changed output falls
  # back to the complete UI gate.
  local ui_test_count
  if ! ui_test_count="$(bun -e '
    const raw = await Bun.stdin.text();
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end < start) process.exit(1);
    const result = JSON.parse(raw.slice(start, end + 1));
    if (!Number.isInteger(result.numTotalTestSuites) || result.numTotalTestSuites < 1) process.exit(1);
    if (!Number.isInteger(result.numTotalTests) || result.numTotalTests < 0) process.exit(1);
    process.stdout.write(String(result.numTotalTests));
  ' <"$related_log")"; then
    run_full_ui_tests
  else
    tests_executed=$((tests_executed + ui_test_count))
  fi
  rm -f -- "$related_log"
  related_log=""
}

run_browser_tests() {
  ((${#changed_browser_tests[@]})) || return 0
  local -A selected=()
  local file
  for file in "${changed_browser_tests[@]}"; do
    selected["$file"]=1
  done
  mapfile -t changed_browser_tests < <(
    printf '%s\n' "${!selected[@]}" | LC_ALL=C sort
  )
  browser_phase_ran=1
  run_phase "Browser tests" bash scripts/test-browser.sh "${changed_browser_tests[@]}"
  add_browser_test_count "$verify_log"
}

# Reuse of an earlier `--changed` pass.
#
# A pass is recorded in a stamp file in the worktree's private git directory
# (never visible to `git status`). It is keyed on the git TREE of the current
# working state, not the HEAD sha, because the board may commit leftover changes
# between stages without altering any file content. The stamp also records the
# comparison base and the verifier's own script hashes so that a different base
# or verifier always runs the gates again. Full and targeted runs never touch it.
verify_tree_key() {
  local status_output index_path tmp_index tree=""
  status_output="$(git --no-optional-locks status --porcelain)" || return 1
  if [[ -z "$status_output" ]]; then
    git rev-parse 'HEAD^{tree}' 2>/dev/null
    return
  fi
  # Hash the working state through a scratch copy of the index so the real
  # index is never modified. `add -A` honors .gitignore.
  index_path="$(git rev-parse --git-path index)" || return 1
  tmp_index="$(mktemp "${TMPDIR:-/tmp}/carapa-verify-index.XXXXXX")" || return 1
  rm -f -- "$tmp_index"
  if [[ -e "$index_path" ]] && ! cp -- "$index_path" "$tmp_index"; then
    rm -f -- "$tmp_index"
    return 1
  fi
  if GIT_INDEX_FILE="$tmp_index" git add -A >/dev/null 2>&1; then
    tree="$(GIT_INDEX_FILE="$tmp_index" git write-tree 2>/dev/null)" || tree=""
  fi
  rm -f -- "$tmp_index"
  [[ -n "$tree" ]] || return 1
  printf '%s\n' "$tree"
}

verify_script_hash() {
  sha256sum -- "$1" 2>/dev/null | awk '{ print $1 }'
}

try_reuse_verify_pass() {
  [[ "${CARAPA_VERIFY_REUSE:-1}" != 0 ]] || return 1
  [[ -n "$verify_stamp_file" && -f "$verify_stamp_file" ]] || return 1

  local line stamp_tree="" stamp_ref="" stamp_verify="" stamp_changed=""
  local stamp_tests="" stamp_summary="" stamp_time=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      tree=*) stamp_tree="${line#tree=}" ;;
      comparison_ref=*) stamp_ref="${line#comparison_ref=}" ;;
      verify_sh=*) stamp_verify="${line#verify_sh=}" ;;
      verify_changed_sh=*) stamp_changed="${line#verify_changed_sh=}" ;;
      tests_executed=*) stamp_tests="${line#tests_executed=}" ;;
      summary=*) stamp_summary="${line#summary=}" ;;
      timestamp=*) stamp_time="${line#timestamp=}" ;;
    esac
  done <"$verify_stamp_file"
  [[ -n "$stamp_tree" && -n "$stamp_ref" && -n "$stamp_verify" && \
     -n "$stamp_changed" && -n "$stamp_summary" && -n "$stamp_time" && \
     "$stamp_tests" =~ ^[0-9]+$ ]] || return 1
  [[ "$stamp_ref" == "$comparison_ref" ]] || return 1
  [[ "$stamp_verify" == "$(verify_script_hash scripts/verify.sh)" ]] || return 1
  [[ "$stamp_changed" == "$(verify_script_hash scripts/verify-changed.sh)" ]] || return 1

  local current_tree
  current_tree="$(verify_tree_key)" || return 1
  [[ -n "$current_tree" && "$current_tree" == "$stamp_tree" ]] || return 1

  printf 'Verification passed: reused earlier pass (tree %s, %s)\n' "${current_tree:0:12}" "$stamp_time"
  printf 'Tests executed: 0\n'
  printf '  reused: %s, %s tests at %s\n' "$stamp_summary" "$stamp_tests" "$stamp_time"
}

write_verify_pass_stamp() {
  [[ -n "$verify_stamp_file" ]] || return 0
  local tree script_sha changed_sha tmp
  tree="$(verify_tree_key)" || return 0
  script_sha="$(verify_script_hash scripts/verify.sh)"
  changed_sha="$(verify_script_hash scripts/verify-changed.sh)"
  [[ -n "$tree" && -n "$script_sha" && -n "$changed_sha" ]] || return 0
  tmp="$(mktemp "${verify_stamp_file}.XXXXXX")" || return 0
  if printf 'tree=%s\ncomparison_ref=%s\nverify_sh=%s\nverify_changed_sh=%s\ntests_executed=%d\nsummary=%s\ntimestamp=%s\n' \
       "$tree" "$comparison_ref" "$script_sha" "$changed_sha" "$tests_executed" \
       "$selection_summary" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$tmp"; then
    mv -f -- "$tmp" "$verify_stamp_file" || rm -f -- "$tmp"
  else
    rm -f -- "$tmp"
  fi
}

if (( $# )) && [[ "$1" == "--changed" ]]; then
  verify_mode="changed"
  comparison_ref_source="worktree"
  shift
elif (( $# )) && [[ "$1" == --changed=* ]]; then
  verify_mode="changed"
  comparison_ref="${1#--changed=}"
  comparison_ref_source="argument"
  shift
fi

if [[ "$verify_mode" == "changed" ]]; then
  if [[ -n "${CARAPA_VERIFY_BASE_SHA+x}" ]]; then
    comparison_ref_source="injected"
    if [[ -z "$CARAPA_VERIFY_BASE_SHA" ]] || \
       ! comparison_ref="$(git rev-parse --verify "${CARAPA_VERIFY_BASE_SHA}^{commit}" 2>/dev/null)" || \
       ! git merge-base --is-ancestor "$comparison_ref" HEAD 2>/dev/null; then
      comparison_ref_valid=0
      comparison_ref="invalid injected base"
      printf 'Verification warning: CARAPA_VERIFY_BASE_SHA is not a valid ancestor of HEAD; running conservative full-domain gates.\n' >&2
    else
      # A long-running agent may have started before its task branch was
      # synchronized with a newer default branch. Advance a stale injected
      # base only when the current worktree base is its proven descendant;
      # unrelated or older refs cannot replace the trusted task boundary.
      synchronized_base=""
      if synchronized_base="$(resolve_worktree_base)" && \
         [[ -n "$synchronized_base" && "$synchronized_base" != "$comparison_ref" ]] && \
         git merge-base --is-ancestor "$comparison_ref" "$synchronized_base" 2>/dev/null; then
        comparison_ref="$synchronized_base"
        comparison_ref_source="injected+worktree:${default_branch}"
      fi
    fi
  elif [[ "$comparison_ref_source" == "worktree" ]]; then
    if comparison_ref="$(resolve_worktree_base)" && [[ -n "$comparison_ref" ]]; then
      comparison_ref_source="worktree:${default_branch}"
    else
      comparison_ref_valid=0
    fi
    if (( ! comparison_ref_valid )); then
      comparison_ref="unresolved worktree base"
      printf 'Verification warning: could not resolve the merge-base of HEAD and default branch %s; running conservative full-domain gates.\n' \
        "$default_branch" >&2
    fi
  fi
  # An argument ref is not resolved to a commit, so it cannot key a reusable pass.
  if (( comparison_ref_valid )) && [[ "$comparison_ref_source" != "argument" ]]; then
    verify_stamp_file="$(git rev-parse --git-path carapa-verify-pass 2>/dev/null)" || verify_stamp_file=""
    if try_reuse_verify_pass; then
      exit 0
    fi
  fi
  resolved_head="$(git rev-parse --verify HEAD 2>/dev/null || printf 'unknown')"
  classify_changed_inputs
  collect_changed_format_files
  prepare_backend_tests
fi

static_phases=()
if (( run_backend_static )); then
  if [[ "$verify_mode" != "changed" ]] || ((${#changed_format_files[@]} == 0)); then
    static_phases+=("Format check" 'bun run format:check')
  fi
  static_phases+=("Backend typecheck" 'bun run typecheck')
  static_phases+=("Group fs guard" 'bun scripts/check-group-fs.ts')
fi
static_phases+=("Knip gate" 'bun run knip:gate')
if (( run_ui_static )); then
  static_phases+=("UI typecheck" 'cd ui && npm run typecheck')
fi
if [[ "$verify_mode" == "changed" ]] && ((${#changed_format_files[@]})); then
  run_phase "Format changed files" bun x prettier --write -- "${changed_format_files[@]}"
fi
if [[ "$verify_mode" == "changed" && -z "$verification_skip_reason" ]] && is_semantic_noop_change; then
  verification_skip_reason="semantic no-op (formatting/comments only)"
fi
if [[ -n "$verification_skip_reason" ]]; then
  printf 'Verification passed: %s\n' "$verification_skip_reason"
  printf 'Tests executed: 0\n'
  printf '  changed vs %s -- backend tests off, ui tests off\n' "$comparison_ref"
  if [[ "${CARAPA_VERIFY_TIMING:-0}" == 1 ]]; then
    printf 'Verification revision: base=%s head=%s source=%s\n' \
      "$comparison_ref" "$resolved_head" "$comparison_ref_source"
    verify_finished_at="$(date +%s%N)"
    awk -F '\t' '
      BEGIN { print "Verification timings (seconds):" }
      { printf "  %s\t%.3f\n", $1, ($3 - $2) / 1000000000 }
    ' "$timing_log"
    awk -v started="$verify_started_at" -v finished="$verify_finished_at" \
      'BEGIN { printf "  Total\t%.3f\n", (finished - started) / 1000000000 }'
  fi
  exit 0
fi
if (( ${#static_phases[@]} )); then
  run_concurrent_phases "${static_phases[@]}"
fi
if (( run_android_guard )); then
  run_phase "Android native version guard" bash ui/android/check-native-version.sh
fi

if [[ "$verify_mode" == "changed" ]]; then
  run_backend_tests
  run_ui_tests
  run_browser_tests
elif (( $# )); then
    run_phase "Targeted tests" bash -c '. ./scripts/load-test-env.sh && exec env LOG_LEVEL=silent bun test --no-env-file --only-failures "$@"' _ "$@"
  add_bun_test_count "$verify_log"
  run_ui_tests
else
  run_phase "Tests" bun run test:ci
  add_bun_test_count "$verify_log"
  add_vitest_text_count "$verify_log"
fi

if (( run_ui_static )); then
  run_phase "UI build" bash -c 'cd ui && npm run build'
fi

# Success banner.
#
# The gate was historically silent on success, so callers had to rely on the
# exit code to know that every gate passed. That is fragile: an agent whose
# captured exit code is lost to compaction cannot tell a silent pass apart from
# a run whose output never landed. Emit an explicit, greppable marker here so
# green status is visible in the output alone, regardless of exit-code capture.
printf 'Verification passed: all gates green\n'
printf 'Tests executed: %d\n' "$tests_executed"
selection_summary=""
if [[ "$verify_mode" == "changed" ]]; then
  selection_summary="$(printf 'changed vs %s -- backend tests %s, ui tests %s, browser tests %s' "$comparison_ref" \
    "$([ "$changed_backend_tests" -eq 1 ] && echo on || echo off)" \
    "$([ "$changed_ui_tests" -eq 1 ] && echo on || echo off)" \
    "$([ "${#changed_browser_tests[@]}" -gt 0 ] && echo on || echo off)")"
  printf '  %s\n' "$selection_summary"
else
  printf '  full suite\n'
fi
if (( browser_phase_ran )); then
  printf 'Browser tests executed: %d\n' "$browser_tests_executed"
  awk -F '\t' '$1 == "Browser tests" { printf "Browser phase duration: %.3fs\n", ($3 - $2) / 1000000000 }' "$timing_log"
fi
if [[ "$verify_mode" == "changed" ]]; then
  write_verify_pass_stamp
fi

if [[ "${CARAPA_VERIFY_TIMING:-0}" == 1 ]]; then
  if [[ "$verify_mode" == "changed" ]]; then
    printf 'Verification revision: base=%s head=%s source=%s\n' \
      "$comparison_ref" "$resolved_head" "$comparison_ref_source"
  fi
  verify_finished_at="$(date +%s%N)"
  awk -F '\t' '
    BEGIN { print "Verification timings (seconds):" }
    { printf "  %s\t%.3f\n", $1, ($3 - $2) / 1000000000 }
  ' "$timing_log"
  awk -v started="$verify_started_at" -v finished="$verify_finished_at" \
    'BEGIN { printf "  Total\t%.3f\n", (finished - started) / 1000000000 }'
fi
