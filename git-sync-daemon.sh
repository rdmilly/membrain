#!/bin/bash
# Git auto-sync daemon for memory-ext
# Watches for file changes and auto-commits + pushes
REPO="/opt/projects/memory-ext"
GH_TOKEN="${GITHUB_TOKEN:-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}"

cd "$REPO"
git config user.email 'helix@millyweb.com'
git config user.name 'Helix Cortex'
git remote set-url origin "https://rdmilly:${GH_TOKEN}@github.com/rdmilly/membrain.git"

echo "[git-sync] Watching $REPO..."

inotifywait -m -r -e close_write \
  --exclude '(\.git|node_modules|\.bak|\.zip|\.sh)' \
  --format '%w%f' \
  "$REPO" 2>/dev/null | while read CHANGED_FILE; do

  # Debounce: wait 3s for burst writes to settle
  sleep 3

  cd "$REPO"
  CHANGED=$(git status --porcelain | grep -v '^??' | head -5)
  [ -z "$CHANGED" ] && continue

  # Get list of changed files for commit message
  FILES=$(git diff --name-only HEAD 2>/dev/null | head -3 | tr '\n' ' ')
  [ -z "$FILES" ] && FILES=$(git status --porcelain | grep -v '^??' | awk '{print $2}' | head -3 | tr '\n' ' ')

  git add -A
  git commit -m "[helix] auto: ${FILES}" && \
  git push origin main && \
  echo "[git-sync] Committed + pushed: ${FILES}" || \
  echo "[git-sync] Commit/push failed"
done
