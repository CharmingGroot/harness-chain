#!/bin/bash
# Builds core-agent packages and syncs dist/ files into harness-chain's pnpm store.
# Run this whenever you update @charming_groot/* packages.

set -e

CORE_AGENT_ROOT="/Users/hg/repo/core-agent"
STORE_ROOT="$(dirname "$0")/../node_modules/.pnpm/@charming_groot+providers@0.1.2_zod@4.3.6/node_modules/@charming_groot/providers/dist"

echo "==> Building core-agent packages..."
(cd "$CORE_AGENT_ROOT" && pnpm --filter @charming_groot/core build && pnpm --filter @charming_groot/providers build && pnpm --filter @charming_groot/agent build)

echo "==> Syncing @charming_groot/providers dist..."
cp -r "$CORE_AGENT_ROOT/packages/providers/dist/." "$STORE_ROOT/"

echo "==> Syncing @charming_groot/core dist..."
CORE_STORE="$(dirname "$0")/../node_modules/.pnpm/@charming_groot+core@0.1.2_zod@4.3.6/node_modules/@charming_groot/core/dist"
cp -r "$CORE_AGENT_ROOT/packages/core/dist/." "$CORE_STORE/"

echo "==> Syncing @charming_groot/agent dist..."
AGENT_STORE=$(find "$(dirname "$0")/../node_modules/.pnpm" -name "index.js" -path "*charming_groot+agent*" 2>/dev/null | head -1 | xargs dirname 2>/dev/null || echo "")
if [ -n "$AGENT_STORE" ]; then
  cp -r "$CORE_AGENT_ROOT/packages/agent/dist/." "$AGENT_STORE/"
fi

echo "==> Done. Restart the dev server to pick up changes."
