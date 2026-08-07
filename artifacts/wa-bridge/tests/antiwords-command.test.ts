import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-antiwords-'));
process.env.WORKSPACE_ROOT = tmpRoot;

const { initWorkspace } = await import('../src/services/workspace.js');
const { loadGroupAntiConfig } = await import('../src/whatsapp/anti-system/config.js');
const { handleAntiCommand, handleAntiWordsCommand } = await import('../src/whatsapp/anti-system/commands.js');
const { parseCommand } = await import('../src/whatsapp/command-parser.js');

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const telegramId = 'tg-antiwords-test';
const sessionId = 'session-antiwords-test';
const groupJid = '120363000000000000@g.us';

initWorkspace(telegramId);

test('antiwords warn 3[words] stores only the requested words and threshold', () => {
  const out = handleAntiWordsCommand(
    ['warn', '3[scam,', 'fraud]'],
    telegramId,
    sessionId,
    groupJid,
    '.'
  );
  const config = loadGroupAntiConfig(telegramId, sessionId, groupJid);

  assert.match(out, /𝗔 𝗡 𝗧 𝗜 𝗪 𝗢 𝗥 𝗗 𝗦/);
  assert.deepEqual(config.antiwords, {
    enabled: true,
    action: 'warn',
    warnThreshold: 3,
    permitList: [],
    words: ['scam', 'fraud'],
  });
});

test('AntiText remains a plain-text module with no word list', () => {
  const out = handleAntiCommand(
    'antitext',
    'antitxt',
    ['warn', '3'],
    telegramId,
    sessionId,
    groupJid,
    '.'
  );
  const config = loadGroupAntiConfig(telegramId, sessionId, groupJid);

  assert.match(out, /𝗔 𝗡 𝗧 𝗜 𝗧 𝗘 𝗫 𝗧/);
  assert.equal(config.antitxt?.enabled, true);
  assert.equal(config.antitxt?.action, 'warn');
  assert.equal('words' in (config.antitxt ?? {}), false);
});

test('antitext is accepted as an alias for the existing antitxt command', () => {
  const parsed = parseCommand('.antitext warn 3', {
    prefix: '.',
    nullPrefix: false,
    stickerMacros: {},
  } as any);

  assert.equal(parsed?.command, 'antitxt');
  assert.deepEqual(parsed?.args, ['warn', '3']);
});
