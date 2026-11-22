#!/bin/sh
# Provision a carapa-board git worktree for agent runs.
#
# Invoked by carapa-box sandbox_worktree after symlink provisioning (CWD = worktree
# root). Reuses node_modules from the main checkout when lockfiles match; otherwise
# installs fresh. See carapa-box/docs/git-worktrees.md.
set -eu

ROOT="$(pwd)"

main_worktree() {
  git worktree list --porcelain | awk '
    /^worktree / { sub(/^worktree /, ""); wt = $0 }
    wt != "" && wt !~ /\.worktrees\// { print wt; exit }
  '
}

remove_modules_dir() {
  target="$1"
  if [ -L "$target" ]; then
    rm -f "$target"
  elif [ -d "$target" ]; then
    rm -rf "$target"
  fi
}

# subdir: "" for repo root, "ui" for frontend
# lock_name: bun.lock or package-lock.json
# install_cmd: run inside that directory when a fresh install is needed
link_or_install() {
  subdir="$1"
  lock_name="$2"
  install_cmd="$3"

  if [ -n "$subdir" ]; then
    wt_dir="$ROOT/$subdir"
    main_dir="$MAIN/$subdir"
    label="$subdir/"
  else
    wt_dir="$ROOT"
    main_dir="$MAIN"
    label=""
  fi

  wt_lock="$wt_dir/$lock_name"
  main_lock="$main_dir/$lock_name"
  wt_modules="$wt_dir/node_modules"
  main_modules="$main_dir/node_modules"

  if [ ! -f "$wt_lock" ]; then
    echo "worktree-setup: skip $label(no $lock_name)" >&2
    return 0
  fi

  if [ -d "$main_modules" ] && [ -f "$main_lock" ] && cmp -s "$main_lock" "$wt_lock"; then
    remove_modules_dir "$wt_modules"
    ln -sfn "$main_modules" "$wt_modules"
    echo "worktree-setup: linked ${label}node_modules from main"
    return 0
  fi

  echo "worktree-setup: installing ${label}dependencies"
  remove_modules_dir "$wt_modules"
  (cd "$wt_dir" && eval "$install_cmd")
}

MAIN="$(main_worktree)"
if [ -z "$MAIN" ] || [ ! -d "$MAIN" ]; then
  echo "worktree-setup: could not resolve main checkout" >&2
  exit 1
fi

if [ -f "$ROOT/bun.lock" ]; then
  if command -v bun >/dev/null 2>&1; then
    link_or_install "" "bun.lock" "bun install --frozen-lockfile"
  else
    echo "worktree-setup: bun not found; skipping backend node_modules" >&2
  fi
elif [ -f "$ROOT/package-lock.json" ]; then
  link_or_install "" "package-lock.json" "npm ci --no-audit --no-fund"
fi

if [ -d "$ROOT/ui" ] && [ -f "$ROOT/ui/bun.lock" ]; then
  if command -v bun >/dev/null 2>&1; then
    link_or_install "ui" "bun.lock" "bun install --frozen-lockfile"
  else
    echo "worktree-setup: bun not found; skipping ui/ dependencies" >&2
  fi
fi

echo "worktree-setup: ok ($ROOT)"
