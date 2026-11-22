#!/usr/bin/env bash
# Run the standard validation gates for every change owned by this worktree:
# committed branch changes since its default-branch merge-base, plus staged,
# unstaged, and untracked files. The full suite remains a CI gate.

set -euo pipefail

exec bash "$(dirname "$0")/verify.sh" --changed
