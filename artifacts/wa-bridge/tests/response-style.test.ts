import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorCard, successCard } from '../src/utils/ascii-art.js';
import { cmdTag, cmdMTag } from '../src/whatsapp/commands/tag.js';

test('WhatsApp cards use the spaced title, sections, and PAPPY footer', () => {
  const text = successCard('VIEW ONCE', 'Reply to a View Once image or video.\nUsage: .vv | .vvdm');

  assert.match(text, /^✅ 𝗩 𝗜 𝗘 𝗪  𝗢 𝗡 𝗖 𝗘/);
  assert.match(text, /✦ Instructions\n  └─ Reply to a View Once image or video\./);
  assert.match(text, /✦ Usage\n  └─ \.vv \| \.vvdm/);
  assert.match(text, /· · ——— 𝕻𝕬𝕻𝕻𝖞 ×͜× ——— · ·$/);
  assert.doesNotMatch(text, /╭─|╰─ 𝗢𝗠𝗘𝗚𝗔/);
});

test('tag refuses an empty payload without contacting WhatsApp', async () => {
  const result = await cmdTag(
    {} as any,
    'tg',
    'session',
    '123@g.us',
    '',
  );
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /real text or media payload is required/i);
});

test('mtag refuses an empty payload without contacting WhatsApp', async () => {
  const result = await cmdMTag(
    {} as any,
    'tg',
    'session',
    '123@g.us',
    '',
  );
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /real text or media payload is required/i);
});

test('error cards use the same unified layout', () => {
  const text = errorCard('PAYLOAD REQUIRED', 'Send text or reply to media.');
  assert.match(text, /^❌ 𝗣 𝗔 𝗬 𝗟 𝗢 𝗔 𝗗  𝗥 𝗘 𝗤 𝗨 𝗜 𝗥 𝗘 𝗗/);
  assert.match(text, /✦ Instructions/);
  assert.match(text, /𝕻𝕬𝕻𝕻𝖞/);
});
