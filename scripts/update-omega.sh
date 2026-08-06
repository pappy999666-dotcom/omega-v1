#!/bin/bash
# ============================================================
# OMEGA-V1 • SAFE UPDATE SCRIPT (run on your VPS)
#
# Usage:  bash scripts/update-omega.sh
#
# Why this exists: session/auth data used to live INSIDE the git
# repository (artifacts/workspaces) and got wiped on every update.
# Data now lives OUTSIDE the repo in ~/.omega-v1/workspaces.
#
# This script:
#   1. Backs up BOTH the new persistent root (~/.omega-v1/workspaces)
#      and the legacy in-repo root (artifacts/workspaces) — your first
#      update after this change still has data in the legacy path.
#   2. Pre-migrates legacy data into the new root BEFORE pulling, so
#      even though git removes the tracked legacy files during the
#      pull, your sessions are already safe.
#   3. Restores everything if the pull fails.
# ============================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

BACKUP_DIR="${OMEGA_BACKUP_DIR:-/tmp/omega-backup}"
SESSION_ROOT="${OMEGA_DATA_DIR:-$HOME/.omega-v1/workspaces}"
LEGACY_ROOT="$APP_DIR/artifacts/workspaces"

echo "==> 1/6 Backing up session data..."
rm -rf "$BACKUP_DIR"
mkdir -p "$BACKUP_DIR"

if [ -d "$SESSION_ROOT" ] && [ -n "$(ls -A "$SESSION_ROOT" 2>/dev/null)" ]; then
  cp -r "$SESSION_ROOT" "$BACKUP_DIR/workspaces-new"
  echo "     Backed up new root: $SESSION_ROOT ($(du -sh "$BACKUP_DIR/workspaces-new" 2>/dev/null | cut -f1))"
else
  echo "     No data yet in new root: $SESSION_ROOT"
fi

if [ -d "$LEGACY_ROOT" ] && [ -n "$(ls -A "$LEGACY_ROOT" 2>/dev/null)" ]; then
  cp -r "$LEGACY_ROOT" "$BACKUP_DIR/workspaces-legacy"
  echo "     Backed up legacy root: $LEGACY_ROOT ($(du -sh "$BACKUP_DIR/workspaces-legacy" 2>/dev/null | cut -f1))"
  # Pre-migrate into the new root BEFORE pulling — git will remove the
  # tracked legacy files during the pull, so copy them out first.
  mkdir -p "$SESSION_ROOT"
  cp -rn "$LEGACY_ROOT/." "$SESSION_ROOT/" 2>/dev/null || cp -r "$LEGACY_ROOT/." "$SESSION_ROOT/"
  echo "     Pre-migrated legacy data → $SESSION_ROOT"
else
  echo "     No legacy in-repo data found at $LEGACY_ROOT"
fi

echo "==> 2/6 Stopping bot (pm2)..."
pm2 stop wa-bridge >/dev/null 2>&1 || echo "     (no running wa-bridge process — continuing)"

echo "==> 3/6 Pulling latest code..."
if ! git pull --ff-only; then
  echo "!! Pull failed — restoring backup and aborting."
  if [ -d "$BACKUP_DIR/workspaces-legacy" ]; then
    mkdir -p "$SESSION_ROOT"
    cp -r "$BACKUP_DIR/workspaces-legacy/." "$SESSION_ROOT/"
  fi
  if [ -d "$BACKUP_DIR/workspaces-new" ]; then
    cp -r "$BACKUP_DIR/workspaces-new/." "$SESSION_ROOT/"
  fi
  exit 1
fi

echo "==> 4/6 Installing dependencies..."
pnpm install --frozen-lockfile || pnpm install

echo "==> 5/6 Rebuilding..."
pnpm --filter @workspace/wa-bridge run build

echo "==> 6/6 Restarting bot (pm2)..."
if pm2 restart wa-bridge >/dev/null 2>&1; then
  echo "     Restarted wa-bridge"
else
  (cd "$APP_DIR/artifacts/wa-bridge" && pm2 start ecosystem.config.js --only wa-bridge) \
    >/dev/null 2>&1 || echo "     Start the bot with your normal command (pm2 start artifacts/wa-bridge/ecosystem.config.js)"
fi

echo ""
echo "✅ Update complete — sessions preserved at $SESSION_ROOT"
