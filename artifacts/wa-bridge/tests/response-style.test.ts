import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorCard, successCard } from '../src/utils/ascii-art.js';
import { cmdTag, cmdMTag } from '../src/whatsapp/commands/tag.js';

test('WhatsApp successful cards use compact action feedback', () => {
  const text = successCard('VIEW ONCE', 'Reply to a View Once image or video.\nUsage: .vv | .vvdm');
  assert.equal(text, '✅ VIEW ONCE\n└ Reply to a View Once image or video.\nUsage: .vv | .vvdm');
  assert.doesNotMatch(text, /𝕻𝕬𝕻𝕻𝖄|╭─/);
});

test('tag refuses an empty payload without contacting WhatsApp', async () => {
  const result = await cmdTag({} as any, 'tg', 'session', '123@g.us', '');
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /real text or media payload is required/i);
});

test('mtag refuses an empty payload without contacting WhatsApp', async () => {
  const result = await cmdMTag({} as any, 'tg', 'session', '123@g.us', '');
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /real text or media payload is required/i);
});

test('error cards use compact useful debugging information', () => {
  const text = errorCard('PAYLOAD REQUIRED', 'Send text or reply to media.');
  assert.equal(text, '❌ PAYLOAD REQUIRED\n└ Send text or reply to media.');
  assert.doesNotMatch(text, /𝕻𝕬𝕻𝕻𝖄|╭─/);
});
