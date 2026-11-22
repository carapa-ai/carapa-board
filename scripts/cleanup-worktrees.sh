#!/usr/bin/env bash
set -euo pipefail

# Clean up task worktrees (.worktrees/) whose branches are already merged.
# Also prunes stale worktree entries and deletes merged branches.
# Usage: cleanup-worktrees.sh [repo-path] [base-branch] [--dry-run|-n] [--min-age=HOURS]
#   Skips branches with commits newer than HOURS (default: 24) to avoid
#   deleting worktrees that an agent may still be working in.

REPO="${1:-.}"
BASE="${2:-develop}"
DRY_RUN=false
MIN_AGE_HOURS=24

for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=true ;;
    --min-age=*) MIN_AGE_HOURS="${arg#--min-age=}" ;;
  esac
done

MIN_AGE_SECS=$((MIN_AGE_HOURS * 3600))
NOW=$(date +%s)

REPO=$(cd "$REPO" && pwd)

if ! git -C "$REPO" rev-parse --git-dir &>/dev/null; then
  echo "Error: $REPO is not a git repository" >&2
  exit 1
fi

if ! git -C "$REPO" rev-parse --verify "$BASE" &>/dev/null; then
  echo "Error: base branch '$BASE' does not exist in $REPO" >&2
  exit 1
fi

# Prune worktree entries that point to non-existent directories
if [ "$DRY_RUN" = true ]; then
  echo "[dry-run] Would prune stale worktree entries"
else
  git -C "$REPO" worktree prune
fi

removed=0
skipped=0

# Parse worktree list: extract path + branch pairs for .worktrees/ entries
wt_path=""
while IFS= read -r line; do
  case "$line" in
    "worktree "*)
      wt_path="${line#worktree }"
      ;;
    "branch "*)
      branch="${line#branch refs/heads/}"
      # Only process task worktrees
      case "$wt_path" in
        */.worktrees/*)
          if git -C "$REPO" rev-parse --verify "$branch" &>/dev/null; then
            # Skip branches with recent commits (may still be in use)
            last_commit=$(git -C "$REPO" log -1 --format="%ct" "$branch" 2>/dev/null || echo "$NOW")
            age=$((NOW - last_commit))
            if [ "$age" -lt "$MIN_AGE_SECS" ]; then
              echo "Skipped (recent, ${age}s old): $branch"
              skipped=$((skipped + 1))
            elif git -C "$REPO" merge-base --is-ancestor "$branch" "$BASE" 2>/dev/null; then
              if [ "$DRY_RUN" = true ]; then
                echo "[dry-run] Would delete branch: $branch"
              else
                echo "Deleting branch: $branch"
                git -C "$REPO" branch -d "$branch" 2>/dev/null || true
              fi
              removed=$((removed + 1))
            else
              echo "Skipped (unmerged): $branch"
              skipped=$((skipped + 1))
            fi
          fi
          ;;
      esac
      wt_path=""
      ;;
    "")
      wt_path=""
      ;;
  esac
done < <(git -C "$REPO" worktree list --porcelain)

# Also catch merged branches that no longer have worktree entries
# (worktree was pruned but branch lingered)
while IFS= read -r branch; do
  branch="${branch#  }"  # strip leading spaces
  [ -z "$branch" ] && continue
  # Skip recent branches
  last_commit=$(git -C "$REPO" log -1 --format="%ct" "$branch" 2>/dev/null || echo "$NOW")
  age=$((NOW - last_commit))
  if [ "$age" -lt "$MIN_AGE_SECS" ]; then
    echo "Skipped (recent, ${age}s old): $branch"
    skipped=$((skipped + 1))
    continue
  fi
  if git -C "$REPO" merge-base --is-ancestor "$branch" "$BASE" 2>/dev/null; then
    if [ "$DRY_RUN" = true ]; then
      echo "[dry-run] Would delete stale branch: $branch"
    else
      echo "Deleting stale branch: $branch"
      git -C "$REPO" branch -d "$branch" 2>/dev/null || true
    fi
    removed=$((removed + 1))
  else
    skipped=$((skipped + 1))
  fi
done < <(git -C "$REPO" branch --merged "$BASE" | grep -v "^\*" | grep -v "^  $BASE$")

# Clean up orphaned .worktrees/ directories whose branch no longer exists
dirs_removed=0
WT_DIR="$REPO/.worktrees"
if [ -d "$WT_DIR" ]; then
  for dir in "$WT_DIR"/*/; do
    [ -d "$dir" ] || continue
    name=$(basename "$dir")
    if ! git -C "$REPO" rev-parse --verify "$name" &>/dev/null; then
      if [ "$DRY_RUN" = true ]; then
        echo "[dry-run] Would remove orphaned dir: .worktrees/$name"
      else
        echo "Removing orphaned dir: .worktrees/$name"
        rm -rf "$dir"
      fi
      dirs_removed=$((dirs_removed + 1))
    fi
  done
fi

echo "Done. Branches removed: $removed, Skipped (unmerged): $skipped, Dirs cleaned: $dirs_removed"
