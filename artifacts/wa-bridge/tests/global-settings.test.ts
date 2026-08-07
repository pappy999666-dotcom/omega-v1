// Global Sudo (per-Telegram-user) & Omni Owner (BOT-WIDE platform) storage tests.
// Run: node --import tsx --test tests/global-settings.test.ts
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-gs-'));
process.env.WORKSPACE_ROOT = tmpRoot;

// Seed a LEGACY pre-promotion user config (omni stored per-user) BEFORE the
// workspace module is first imported, so the load-time migration sweeps it
// into the bot-wide platform config exactly like a real upgrade would.
const legacyPath = path.join(tmpRoot, 'tg-legacy', 'config.json');
fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
fs.writeFileSync(legacyPath, JSON.stringify({
  telegramId: 'tg-legacy',
  isBanned: false,
  isOwner: false,
  prefix: '.',
  nullPrefix: false,
  stickerMacros: {},
  sudoNumbers: [],
  omniOwnerNumbers: ['2348099999999'],
  joinedAt: Date.now(),
  lastActivity: Date.now(),
}));

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

test('omni owner is BOT-WIDE (platform config) and checkable from any user', async () => {
  ws.addOmniOwnerNumbers('tg-A', ['2348033333333']);
  const listA = ws.getOmniOwnerNumbers('tg-A');
  assert.ok(listA.includes('2348033333333'), 'added number present');
  // BOT-WIDE: the same number is visible and effective for every other user too
  const listB = ws.getOmniOwnerNumbers('tg-B');
  assert.ok(listB.includes('2348033333333'), 'same number visible from another user');

  assert.strictEqual(ws.isOmniOwnerNumber('tg-A', '2348033333333'), true);
  // Same number IS omni for another user — omni is bot-wide, not per-user
  assert.strictEqual(ws.isOmniOwnerNumber('tg-B', '2348033333333'), true);
  // Format-insensitive matching
  assert.strictEqual(ws.isOmniOwnerNumber('tg-C', '+234-8033333333'), true);

  ws.removeOmniOwnerNumbers('tg-B', ['2348033333333']);
  assert.ok(!ws.getOmniOwnerNumbers('tg-A').includes('2348033333333'), 'removed everywhere');
});

test('legacy per-user omni numbers migrate into the bot-wide platform config', async () => {
  // The workspace module was first imported by an earlier test AFTER we seeded
  // tg-legacy/config.json, so the load-time migration ran against it.
  // Bot-wide visibility for the legacy owner from any other Telegram user
  assert.strictEqual(ws.isOmniOwnerNumber('tg-other', '2348099999999'), true);
  assert.ok(ws.getOmniOwnerNumbers('tg-other').includes('2348099999999'));
  // The legacy per-user field is cleared after migration
  const after = JSON.parse(fs.readFileSync(legacyPath, 'utf8')) as Record<string, unknown>;
  assert.ok(!('omniOwnerNumbers' in after), 'legacy per-user omni field cleared after migration');
});
