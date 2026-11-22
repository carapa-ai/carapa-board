#!/usr/bin/env bash

# Authoritative process-isolation groups for Bun test runners. Files in these
# groups must never share a Bun process with another suite.
ci_backend_isolated_test_files=(
  src/lib/llm-client.test.ts
  src/lib/media-processor.test.ts
  src/modules/kanban/archive-task.test.ts
  src/modules/kanban/dataset-completion-broadcast.test.ts
  src/modules/kanban/move-task.test.ts
  src/modules/boxes/connections.test.ts
  src/modules/build-info/tools.test.ts
  src/modules/kanban/task/deploy-broadcast.test.ts
  src/modules/memory/history-reflection-llm-attribution.test.ts
  src/modules/memory/memory-audit.test.ts
  src/modules/memory/reflect-workflow.test.ts
  src/modules/objectives/live-voice-websocket-auth.test.ts
  src/modules/push/fcm-sender.test.ts
  src/modules/vector-store/embed-privacy.test.ts
  src/modules/tools/tools.test.ts
  src/recovery-fixes.test.ts
  src/recovery.ipc-fs.test.ts
  src/http-service.server-web-build-status.test.ts
  src/http-service.project-share.test.ts
  src/routes/active-runs.test.ts
  src/routes/conversations-handoff.test.ts
  src/routes/projects-integration-keys.test.ts
  ./src/routes/conversations-direct-stop.integration.ts
  src/routes/_helpers.test.ts
  src/routes/users.test.ts
  src/routes-tasks.test.ts
  src/routes/tmux.test.ts
  src/sandbox/process.ipc-fs.test.ts
  src/sandbox/sandbox-process.test.ts
)

ci_ui_isolated_test_files=(
  ui/src/lib/api-fetch-origin.test.ts
  ui/src/lib/api-fetch-retry.test.ts
  ui/src/lib/websocket-connect.test.ts
  ui/src/lib/push-bridge.test.ts
)

# Native-shell and OTA-client checks are independent from the server/web
# deploy gate. CI runs this domain only when Android-owned inputs change.
ci_android_test_files=(
  src/android-native-version.test.ts
  ui/src/lib/android-ota.test.ts
  ui/src/lib/android-ota.lifecycle.test.ts
  ui/src/lib/native-boot-lock.test.ts
)

# These suites intentionally span backend, UI, or repository build inputs.
ci_contract_test_files=(
  scripts/verify.test.ts
  src/live-mode-coordinator.test.ts
  src/live-mode-e2e.test.ts
)

ci_isolated_test_files=(
  "${ci_backend_isolated_test_files[@]}"
  "${ci_ui_isolated_test_files[@]}"
  "${ci_android_test_files[@]}"
  "${ci_contract_test_files[@]}"
)

sanitize_test_credentials() {
  # Test runners must use local fakes and must never inherit credentials that
  # could authorize an external model request.
  unset \
    ANTHROPIC_API_KEY \
    ANTHROPIC_AUTH_TOKEN \
    CLAUDE_CODE_OAUTH_TOKEN \
    OPENAI_API_KEY \
    CODEX_API_KEY \
    GEMINI_API_KEY \
    GOOGLE_API_KEY \
    OPENROUTER_API_KEY
}
