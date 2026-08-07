// Per-Telegram-user Global Sudo & Omni Owner storage tests.
// Run: node --import tsx --test tests/global-settings.test.ts
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-gs-'));
process.env.WORKSPACE_ROOT = tmpRoot;

import { test } from 'node:test';
import assert from 'node:assert';

type Workspace = typeof import('../src/services/workspace.js');
let ws: Workspace;

test.after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch { /* non-critical */ }
});

test('global settings are isolated per Telegram user', async () => {
  ws = await import('../src/services/workspace.js');

  // User A adds a Global Sudo number
  const next = ws.addGlobalSudoNumbers('tg-A', ['2348011111111']);
  assert.deepStrictEqual(next, ['2348011111111']);
  assert.deepStrictEqual(ws.getGlobalSudoNumbers('tg-A'), ['2348011111111']);

  // User B is unaffected
  assert.deepStrictEqual(ws.getGlobalSudoNumbers('tg-B'), []);
});

test('global sudo add is idempotent and removable', async () => {
  ws.addGlobalSudoNumbers('tg-A', ['2348022222222']);
  ws.addGlobalSudoNumbers('tg-A', ['2348022222222']);
  assert.deepStrictEqual(
    ws.getGlobalSudoNumbers('tg-A'),
    ['2348011111111', '2348022222222']
  );
  ws.removeGlobalSudoNumbers('tg-A', ['2348011111111']);
  assert.deepStrictEqual(ws.getGlobalSudoNumbers('tg-A'), ['2348022222222']);
});

test('omni owner is per-user and checkable', async () => {
  ws.addOmniOwnerNumbers('tg-A', ['2348033333333']);
  assert.deepStrictEqual(ws.getOmniOwnerNumbers('tg-A'), ['2348033333333']);
  assert.deepStrictEqual(ws.getOmniOwnerNumbers('tg-B'), []);

  assert.strictEqual(ws.isOmniOwnerNumber('tg-A', '2348033333333'), true);
  // Same number is NOT omni for another user
  assert.strictEqual(ws.isOmniOwnerNumber('tg-B', '2348033333333'), false);
  // Format-insensitive matching
  assert.strictEqual(ws.isOmniOwnerNumber('tg-A', '+234-8033333333'), true);
});
