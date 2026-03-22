#!/bin/bash
# MemBrain — Extension Setup Script
# Downloads dependencies needed before loading the extension.
#
# Run this once after cloning, and again when upgrading transformers.js.
#
# Usage:
#   cd /opt/projects/memory-ext
#   chmod +x setup.sh && ./setup.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib"

# ==================== TRANSFORMERS.JS ====================
# Xenova/transformers.js — browser-compatible transformer inference
# Used for local all-MiniLM-L6-v2 embeddings (384d)
#
# Quantized model notes:
#   - all-MiniLM-L6-v2 quantized ≈ 6MB (vs 25MB full precision)
#   - Downloaded automatically by the browser on first use via Hugging Face Hub
#   - Cached in browser cache storage (not included in extension)
#
# The script itself (transformers.min.js) is ~1MB and must be bundled.

TRANSFORMERS_VERSION="2.17.2"
TRANSFORMERS_URL="https://cdn.jsdelivr.net/npm/@xenova/transformers@${TRANSFORMERS_VERSION}/dist/transformers.min.js"
TRANSFORMERS_DEST="$LIB_DIR/transformers.min.js"

echo ""
echo "=== MemBrain Extension Setup ==="
echo ""

# Download transformers.js
if [ -f "$TRANSFORMERS_DEST" ]; then
  echo "✓ transformers.min.js already exists ($(du -h "$TRANSFORMERS_DEST" | cut -f1))"
  echo "  To re-download: rm $TRANSFORMERS_DEST && ./setup.sh"
else
  echo "→ Downloading transformers.js v${TRANSFORMERS_VERSION}..."
  curl -L --progress-bar "$TRANSFORMERS_URL" -o "$TRANSFORMERS_DEST"
  SIZE=$(du -h "$TRANSFORMERS_DEST" | cut -f1)
  echo "✓ transformers.min.js downloaded (${SIZE})"
fi

# ==================== VALIDATE ====================

echo ""
echo "=== Validation ==="
echo ""

REQUIRED_FILES=(
  "manifest.json"
  "background/service-worker.js"
  "content/bridge.js"
  "content/hud.js"
  "content/token-hud.js"
  "interceptor/interceptor.js"
  "interceptor/compression.js"
  "lib/event-bus.js"
  "lib/event-types.js"
  "lib/conversation-parser.js"
  "lib/fact-extractor.js"
  "lib/memory-injector.js"
  "lib/storage.js"
  "lib/vector-store.js"
  "lib/embedder.js"
  "lib/vector-backend.js"
  "lib/transformers.min.js"
  "popup/popup.html"
  "popup/popup.js"
  "options/options.html"
  "options/options.js"
  "icons/icon16.png"
  "icons/icon128.png"
)

ALL_OK=true
for f in "${REQUIRED_FILES[@]}"; do
  if [ -f "$SCRIPT_DIR/$f" ]; then
    echo "  ✓ $f"
  else
    echo "  ✗ MISSING: $f"
    ALL_OK=false
  fi
done

echo ""
if $ALL_OK; then
  echo "✓ All required files present."
  echo ""
  echo "=== Load in Chrome ==="
  echo "  1. Open chrome://extensions"
  echo "  2. Enable Developer Mode (top right)"
  echo "  3. Click 'Load unpacked'"
  echo "  4. Select: $SCRIPT_DIR"
  echo ""
  echo "=== First run notes ==="
  echo "  - The embedding model (~6MB quantized) downloads on first fact extraction"
  echo "  - Model is cached in browser storage — subsequent starts are instant"
  echo "  - Check the extension's service worker console for [MemBrain] logs"
else
  echo "✗ Some files are missing. Check the list above."
  exit 1
fi

# ==================== PACKAGE (optional) ====================

if [ "$1" == "--zip" ]; then
  echo ""
  echo "=== Building ZIP for Chrome Web Store ==="
  VERSION=$(python3 -c "import json; print(json.load(open('$SCRIPT_DIR/manifest.json'))['version'])")
  ZIP_NAME="membrain-v${VERSION}.zip"

  cd "$SCRIPT_DIR"
  zip -r "/opt/projects/${ZIP_NAME}" . \
    --exclude "*.bak" \
    --exclude "*.bak-*" \
    --exclude ".git/*" \
    --exclude "setup.sh" \
    --exclude "test/*" \
    --exclude "*.zip" \
    --exclude ".DS_Store"

  SIZE=$(du -h "/opt/projects/${ZIP_NAME}" | cut -f1)
  echo "✓ Built: /opt/projects/${ZIP_NAME} (${SIZE})"
fi
