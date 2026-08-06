// Targeted tests for the session-persistence fix in src/services/workspace.ts
// Run: node --import tsx --test tests/workspace-migration.test.ts
//
// Verifies the #1 user issue: sessions must live OUTSIDE the git tree and
// legacy in-repo data (artifacts/workspaces) must be migrated on startup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Isolated environment: point WORKSPACE_ROOT at a fresh temp dir ──
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-ws-test-'));
process.env.WORKSPACE_ROOT = tmpRoot;

// The legacy in-repo path the migration must copy from.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const legacyRoot = path.resolve(__dirname, '../src/services/../../workspaces');

// Dynamic import AFTER env is set (module-level migration runs at import time).
const workspace = await import('../src/services/workspace.js');

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('WORKSPACE_ROOT honors the env override (never the in-repo path)', () => {
  assert.equal(workspace.WORKSPACE_ROOT, tmpRoot);
  assert.notEqual(workspace.WORKSPACE_ROOT, legacyRoot, 'must not resolve inside the repo');
});

test('legacy in-repo workspace data is migrated into the new root', () => {
  // artifacts/workspaces/8831887192/config.json is the tracked production data
  const migratedConfig = path.join(tmpRoot, '8831887192', 'config.json');
  assert.ok(fs.existsSync(migratedConfig), 'legacy config should be copied to the new root');
  const parsed = JSON.parse(fs.readFileSync(migratedConfig, 'utf8'));
  assert.equal(parsed.telegramId, '8831887192');
});

test('migration is idempotent (second run does not duplicate or error)', () => {
  workspace.migrateLegacyWorkspaces();
  const entries = fs.readdirSync(path.join(tmpRoot, '8831887192', 'buckets'));
  assert.ok(entries.includes('active.json'));
});

test('workspaceDir/sessionDir resolve under the new root', () => {
  assert.equal(workspace.workspaceDir('123'), path.join(tmpRoot, '123'));
  assert.equal(
    workspace.sessionAuthDir('123', 'sess-1'),
    path.join(tmpRoot, '123', 'sessions', 'sess-1', 'auth')
  );
});

test('saveConfig writes atomically with no leftover temp files', () => {
  const tid = '999';
  const cfg = { telegramId: tid, isBanned: false, prefix: '.', nullPrefix: false } as unknown as Parameters<typeof workspace.saveConfig>[1];
  workspace.saveConfig(tid, cfg);
  const p = workspace.configPath(tid);
  assert.ok(fs.existsSync(p));
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(parsed.telegramId, '999');
  // No .tmp-* leftovers
  const leftovers = fs.readdirSync(path.dirname(p)).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});
