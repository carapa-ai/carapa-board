#!/bin/sh
# Tear down carapa-board worktree-local resources before carapa-box removes the checkout.
#
# node_modules are either symlinks into the main checkout or live inside this worktree
# directory and are deleted with it. No per-worktree databases or other external
# resources are provisioned for carapa-board today.
set -eu

ROOT="$(pwd)"

for modules in "$ROOT/node_modules" "$ROOT/ui/node_modules"; do
  if [ -L "$modules" ]; then
    rm -f "$modules"
  fi
done

echo "worktree-teardown: ok ($ROOT)"
