import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_COMMANDS } from '../src/whatsapp/command-parser.js';
import { MAIN_NAV, helpPageText, renderNavHub } from '../src/whatsapp/menu-registry.js';
import { cmdPStatus } from '../src/whatsapp/personal-engine.js';

test('help is a plain-text numbered command list with next-page instructions', () => {
  const result = helpPageText('.', 1, 'all', ALL_COMMANDS);
  assert.ok(result.totalPages > 1);
  assert.match(result.text, /📖 𝗛 𝗘 𝗟 𝗣  𝄜  𝟭 \/ 𝟰/);
  assert.doesNotMatch(result.text, /╭─〔|│ ✦|╰─────────────/);
  assert.match(result.text, /✦ 𝗴𝗼𝗱𝗰𝗮𝘀𝘁\n  └─ Post designed status for current group\n\n✦/);
  assert.match(result.text, /Next: \.help 2/);
  assert.match(result.text, /Send \.help 2 to continue\./);
  assert.match(result.text, /✦ 𝘁𝗼𝗰𝗵𝗮𝘁 \[jid\] \[msg\]/);
  assert.match(result.text, /✦ 𝘃𝘃\n  └─ Recover a View Once image\/video \(reply\)/);
  assert.match(result.text, /✦ 𝗮𝘂𝘁𝗼𝘀𝗲𝗻𝗱 <on\|off>/);
  assert.doesNotMatch(result.text, /use the buttons/i);
  assert.match(result.text, /· · ——— 𝕻𝕬𝕻𝕻𝖄 ×͜× ——— · ·/);

  const page2 = helpPageText('.', 2, 'all', ALL_COMMANDS);
  assert.match(page2.text, /📖 𝗛 𝗘 𝗟 𝗣  𝄜  𝟮 \/ 𝟰/);
  assert.notEqual(page2.text, result.text);
});

test('main navigation includes Pair and plain-text Help descriptions', () => {
  assert.deepEqual(MAIN_NAV.slice(0, 2).map((nav) => nav.id), ['pair', 'help']);
  const text = renderNavHub('.', 'main', ALL_COMMANDS);
  assert.match(text, /✦ 🔗 Pair/);
  assert.match(text, /✦ 📖 Help/);
  assert.match(text, /plain text/);
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
  assert.match(out, /𝗣 𝗘 𝗥 𝗦 𝗢 𝗡 𝗔 𝗟  𝗦 𝗧 𝗔 𝗧 𝗨 𝗦/);
  assert.match(out, /Post failed/);
});
