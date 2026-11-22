#!/usr/bin/env bash
# Compatibility entrypoint for the published quick-install URL.
# The installer implementation lives with the setup skill.
set -euo pipefail
source_file="${BASH_SOURCE[0]:-}"
if [[ -n "$source_file" ]]; then
    installer="$(dirname "$source_file")/../.agent/skills/setup/scripts/quick-install.sh"
    if [[ -f "$installer" ]]; then
        exec bash "$installer" "$@"
    fi
fi
# Also support the original curl | bash invocation without a local checkout.
curl -fsSL https://raw.githubusercontent.com/carapa-ai/carapa-board/main/.agent/skills/setup/scripts/quick-install.sh |
    bash -s -- "$@"
