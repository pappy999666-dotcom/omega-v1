import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_COMMANDS } from '../src/whatsapp/command-parser.js';
import { MAIN_NAV, renderNavHub } from '../src/whatsapp/menu-registry.js';
import { generateWhatsAppHelp } from '../src/services/help.js';
import { cmdPStatus } from '../src/whatsapp/personal-engine.js';

test('help is command inspection, not a paginated menu', () => {
  const intro = generateWhatsAppHelp('.', false);
  assert.match(intro, /𝗛𝗘𝗟𝗣 𝗘𝗡𝗚𝗜𝗡𝗘/);
  assert.match(intro, /\.help <command>/);
  assert.match(intro, /\.help pair/);
  assert.doesNotMatch(intro, /Next:|𝗢𝗠𝗘𝗚𝗔-𝗩𝟭 𝗠𝗘𝗡𝗨/);
});

test('main navigation is the four-route dashboard', () => {
  assert.deepEqual(MAIN_NAV.map((nav) => nav.id), ['group', 'status', 'game', 'extras']);
  const text = renderNavHub('.', 'main', ALL_COMMANDS);
  assert.match(text, /✦ ⚔️ Group/);
  assert.match(text, /✦ 📲 Status/);
  assert.match(text, /✦ 🎮 Game/);
  assert.match(text, /✦ 🧰 Extras/);
});

test('pstatus does not claim success when WhatsApp returns no message key', async () => {
  const socket: any = {
    user: { id: '2348012345678:1@s.whatsapp.net' },
    sendMessage: async () => ({}),
  };
  const msg: any = {
    key: { id: 'status-test', remoteJid: '2348012345678@s.whatsapp.net' },
    message: { conversation: '.pstatus test' },
  };
  const out = await cmdPStatus(socket, 'tg-status', 'sess-status', msg, 'test', '.');
  assert.match(out, /❌ PERSONAL STATUS/);
  assert.match(out, /Post failed/);
});
