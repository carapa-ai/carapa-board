#!/usr/bin/env bash

# npm's command shell exits immediately on Ctrl+C, which can tear down the PTY
# before start.ts finishes its asynchronous browser/process/data cleanup. Keep a
# small foreground supervisor alive until that cleanup has completed.

# Isolate the launcher and its children from the terminal's foreground process
# group. The supervisor receives Ctrl+C and gives start.ts a single SIGTERM so
# its cleanup can shut down children in order.
setsid bun scripts/ui-sandbox/start.ts "$@" &
sandbox_pid=$!

# Detached agents have no terminal to press Ctrl+C in. When UI_SANDBOX_PID_FILE
# is set, record start.ts's pid, which is also its process-group id because it
# leads the session created by setsid above, so a bounded `kill -INT` can stop
# it. The npm wrapper's pid is a different process group.
if [ -n "${UI_SANDBOX_PID_FILE:-}" ]; then
  echo "$sandbox_pid" > "$UI_SANDBOX_PID_FILE"
  trap 'rm -f "$UI_SANDBOX_PID_FILE"' EXIT
fi

stop_sandbox() {
  # Ctrl+C reaches this process through the terminal and npm's forwarding.
  # Ignore repeats until cleanup settles, preserving the child's exit code.
  trap '' INT TERM
  kill -TERM "$sandbox_pid" 2>/dev/null || true
  wait "$sandbox_pid"
  exit $?
}

trap stop_sandbox INT TERM
wait "$sandbox_pid"
exit $?
