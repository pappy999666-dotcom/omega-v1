import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashSticker, parseStickerCommand } from '../src/whatsapp/command-parser.js';

// ── hashSticker: unified fingerprint across Buffer / Uint8Array / base64 ──
test('hashSticker is stable for identical bytes', () => {
  const bytes = Buffer.from('sticker-content-abc123');
  assert.equal(hashSticker(bytes), hashSticker(Buffer.from('sticker-content-abc123')));
});

test('hashSticker handles Uint8Array input (Baileys fileSha256)', () => {
  const bytes = Buffer.from('sticker-content-xyz');
  const u8 = new Uint8Array(bytes);
  assert.equal(hashSticker(u8), hashSticker(bytes));
});

test('hashSticker handles base64 string input', () => {
  const bytes = Buffer.from('sticker-content-456');
  const b64 = bytes.toString('base64');
  assert.equal(hashSticker(b64), hashSticker(bytes));
});

test('hashSticker differs for different content', () => {
  assert.notEqual(hashSticker(Buffer.from('aaa')), hashSticker(Buffer.from('bbb')));
});

// ── parseStickerCommand: binding round-trip ──
test('bound sticker resolves its command', () => {
  const config: any = {
    prefix: '.',
    stickerMacros: { [hashSticker(Buffer.from('sticker-A'))]: 'kick @mention' },
  };
  const parsed = parseStickerCommand(Buffer.from('sticker-A'), config);
  assert.ok(parsed);
  assert.equal(parsed!.command, 'kick');
  assert.equal(parsed!.fromSticker, true);
});

test('unbound sticker returns null (no execution, no false trigger)', () => {
  const config: any = { prefix: '.', stickerMacros: {} };
  assert.equal(parseStickerCommand(Buffer.from('sticker-unbound'), config), null);
});

test('quoted/forwarded/saved stickers share the same hash (same bytes → same command)', () => {
  const stickerBytes = Buffer.from('shared-sticker-image');
  const config: any = { prefix: '.', stickerMacros: { [hashSticker(stickerBytes)]: 'warn @mention' } };

  // Direct send
  assert.equal(parseStickerCommand(stickerBytes, config)?.command, 'warn');
  // Forwarded (same media, Uint8Array form)
  assert.equal(parseStickerCommand(new Uint8Array(stickerBytes), config)?.command, 'warn');
  // Saved & resent (same media, base64 form)
  assert.equal(parseStickerCommand(stickerBytes.toString('base64'), config)?.command, 'warn');
});

test('hash is 16 hex chars (compact fingerprint)', () => {
  assert.match(hashSticker(Buffer.from('x')), /^[0-9a-f]{16}$/);
});
