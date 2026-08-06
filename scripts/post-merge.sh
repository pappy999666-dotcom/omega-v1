#!/bin/bash
# ============================================================
# OMEGA-V1 • POST-MERGE HOOK
#
# Runs automatically after `git pull` / `git merge` when installed as
# .git/hooks/post-merge (install once: ln -sf ../../scripts/post-merge.sh .git/hooks/post-merge).
#
# Safe by design:
#   • Installs dependencies and rebuilds ONLY.
#   • Never touches session/auth data — sessions live in
#     ~/.omega-v1/workspaces (outside the git repository).
#   • The old `pnpm --filter db push` step was removed because there is
#     no `db` package in this repo — it failed on every pull and could
#     abort update scripts mid-way.
# ============================================================
set -e

echo "[post-merge] Installing dependencies..."
pnpm install --frozen-lockfile || pnpm install

echo "[post-merge] Rebuilding wa-bridge..."
pnpm --filter @workspace/wa-bridge run build

echo "[post-merge] Done — sessions untouched (stored in ~/.omega-v1/workspaces)."
