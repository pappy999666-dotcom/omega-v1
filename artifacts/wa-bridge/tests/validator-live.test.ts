import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = mkdtempSync(join(tmpdir(), 'omega-validator-live-'));
process.env.WORKSPACE_ROOT = root;
process.env.TELEGRAM_OWNER_ID = 'validator-test';

const { initWorkspace, addToMainBucket, loadBucket } = await import('../src/services/workspace.js');
const { validateLinksHttp } = await import('../src/services/tri-bucket.js');

test('HTTP validator persists each terminal result before emitting live progress', async () => {
  const telegramId = 'validator-test';
  initWorkspace(telegramId);
  addToMainBucket(telegramId, ['not-a-whatsapp-link', 'also-invalid']);

  const snapshots: Array<{ checked: number; dead: number; main: number }> = [];
  const result = await validateLinksHttp(telegramId, async (message) => {
    const checked = Number(message.match(/Checked\s+(\d+)\/2/u)?.[1] ?? 0);
    snapshots.push({
      checked,
      dead: loadBucket(telegramId, 'dead').length,
      main: loadBucket(telegramId, 'main').length,
    });
  });

  assert.deepEqual(result, { activated: 0, killed: 2, errors: 0 });
  assert.deepEqual(snapshots.map((snapshot) => snapshot.dead), [1, 2]);
  assert.deepEqual(snapshots.map((snapshot) => snapshot.main), [1, 0]);
  assert.equal(loadBucket(telegramId, 'active').length, 0);
});
