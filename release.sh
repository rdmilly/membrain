#!/bin/bash
# MemBrain Release Script
# Usage: ./release.sh "what changed"
# Handles: syntax check -> version bump -> changelog -> commit -> push -> repack

set -e
REPO="/opt/projects/memory-ext"
GH_TOKEN="${GITHUB_TOKEN:-$(cat /run/secrets/github_token 2>/dev/null)}"
cd "$REPO"

# --- Args ---
DESCRIPTION="${1:-}"
if [ -z "$DESCRIPTION" ]; then
  echo "Usage: ./release.sh \"what changed\""
  exit 1
fi

# --- Syntax check ---
echo "[1/6] Syntax check..."
ERRORS=0
for f in $(find . -name '*.js' | grep -v transformers.min | grep -v node_modules | grep -v .git); do
  node --check "$f" 2>/dev/null || { echo "  FAIL: $f"; ERRORS=$((ERRORS+1)); }
done
if [ $ERRORS -gt 0 ]; then echo "Aborting: $ERRORS syntax error(s)"; exit 1; fi

# Check for triple-quotes
if grep -rn "'''" --include='*.js' . | grep -v transformers.min | grep -v .git | grep -q .; then
  echo "Aborting: triple-quotes found"; exit 1
fi
echo "  OK"

# --- Version bump ---
echo "[2/6] Bumping version..."
CURRENT=$(cat manifest.json | python3 -c "import sys,json; print(json.load(sys.stdin)['version'])")
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
NEW_VERSION="$MAJOR.$MINOR.$((PATCH+1))"

python3 << PYEOF
import json
with open('manifest.json') as f: d=json.load(f)
d['version']='$NEW_VERSION'
with open('manifest.json','w') as f: json.dump(d,f,indent=2)
PYEOF

# Update version in all JS/HTML files
for f in content/token-hud.js content/bridge.js background/service-worker.js popup/popup.js popup/popup.html; do
  [ -f "$f" ] && sed -i "s/$CURRENT/$NEW_VERSION/g" "$f" || true
done
echo "  $CURRENT -> $NEW_VERSION"

# --- Changelog ---
echo "[3/6] Updating CHANGELOG..."
DATE=$(date +%Y-%m-%d)
TMP=$(mktemp)
echo -e "## v$NEW_VERSION — $DATE\n- $DESCRIPTION\n" > "$TMP"
if [ -f CHANGELOG.md ]; then
  cat CHANGELOG.md >> "$TMP"
fi
mv "$TMP" CHANGELOG.md
echo "  Added entry for v$NEW_VERSION"

# --- Git commit ---
echo "[4/6] Committing..."
git config user.email 'ryan@millyweb.com'
git config user.name 'Ryan Milly'
git remote set-url origin "https://rdmilly:${GH_TOKEN}@github.com/rdmilly/membrain.git"
git add -A
git commit -m "v$NEW_VERSION - $DESCRIPTION"
echo "  Committed"

# --- Push ---
echo "[5/6] Pushing to GitHub..."
git push origin main
echo "  Pushed: https://github.com/rdmilly/membrain"

# --- Repack ---
echo "[6/6] Building zip..."
cd /opt/projects
rm -f "/tmp/membrain-v${NEW_VERSION}.zip"
zip -r "/tmp/membrain-v${NEW_VERSION}.zip" memory-ext/ \
  -x '*.bak*' -x '*.bak-*' -x '*/test/*' -x '*/.git/*' -x '*.sh' -q
cp "/tmp/membrain-v${NEW_VERSION}.zip" "/opt/projects/helixmaster/membrain-v${NEW_VERSION}.zip"
echo "  https://helixmaster.millyweb.com/membrain-v${NEW_VERSION}.zip"

echo ""
echo "✅ Released v$NEW_VERSION"
echo "   GitHub: https://github.com/rdmilly/membrain/commits/main"
echo "   Zip:    https://helixmaster.millyweb.com/membrain-v${NEW_VERSION}.zip"
