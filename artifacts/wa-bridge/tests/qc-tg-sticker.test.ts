import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSvg, layoutLines, parseBgFlag, QC_BG_PRESETS } from '../src/whatsapp/commands/qc-sticker.js';
import { parseTgLink, extractPostMedia } from '../src/whatsapp/commands/tg-sticker.js';
import { isAnimatedWebP } from '../src/whatsapp/utils/webp.js';
import { ALL_COMMANDS } from '../src/whatsapp/command-parser.js';
import { MENU_CATALOG } from '../src/whatsapp/menu-registry.js';

// ── QC — text layout ────────────────────────────────────────

test('QC layout keeps short text on a single line', () => {
  const { lines, fontSize } = layoutLines('TAG');
  assert.equal(lines.join(' '), 'TAG');
  assert.ok(fontSize >= 100, `fontSize ${fontSize} should stay large for short text`);
});

test('QC layout wraps long text into multiple lines', () => {
  const long = 'OMEGA IS THE PREMIUM WHATSAPP AUTOMATION ENGINE FOR EVERYONE';
  const { lines } = layoutLines(long);
  assert.ok(lines.length >= 2, `expected wrapping, got ${lines.length} line(s)`);
  assert.ok(lines.every((l) => l.trim().length > 0));
});

test('QC SVG output is a 512x512 svg containing the text', () => {
  const svg = buildSvg('HELLO');
  assert.match(svg, /<svg[^>]*width="512"[^>]*height="512"/);
  assert.match(svg, />HELLO</);
  assert.match(svg, /tspan/);
});

test('QC svg escapes XML-special characters', () => {
  const svg = buildSvg('A <B> & "C"');
  assert.match(svg, /&lt;B&gt;/);
  assert.match(svg, /&amp;/);
  assert.match(svg, /&quot;C&quot;/);
  // raw special characters must never leak into the svg markup
  assert.ok(!svg.includes('<B> & "C"'));
});

test('QC layout normalizes repeated whitespace', () => {
  const { lines } = layoutLines('  hello    world  ');
  assert.equal(lines.join(' ').trim(), 'hello world');
});

test('QC layout hard-breaks a single unbroken long word', () => {
  const unbroken = 'SUPERCALIFRAGILISTICEXPIALIDOCIOUSSUPERCALIFRAGILISTIC'; // 55 chars, no spaces
  const { lines } = layoutLines(unbroken);
  assert.ok(lines.length >= 2, `expected hard-break, got ${lines.length} line(s)`);
  const joined = lines.join('').replace(/\s+/g, '');
  assert.equal(joined, unbroken, 'hard-break must not drop characters');
});

// ── QC — background flag ────────────────────────────────────

test('QC defaults to transparent background', () => {
  const { text, bg } = parseBgFlag('HELLO WORLD');
  assert.equal(text, 'HELLO WORLD');
  assert.equal(bg.kind, 'transparent');
  assert.ok(!buildSvg('HELLO', bg).includes('<rect width="512" height="512"'));
});

test('QC parses preset bg and strips the flag', () => {
  const { text, bg } = parseBgFlag('OMEGA --bg ocean');
  assert.equal(text, 'OMEGA');
  assert.equal(bg.kind, 'gradient');
  assert.equal(bg.label, 'ocean');
  assert.equal(bg.from, QC_BG_PRESETS.ocean!.from);
});

test('QC parses hex solid bg', () => {
  const { text, bg } = parseBgFlag('TAG --bg #ff5500');
  assert.equal(text, 'TAG');
  assert.equal(bg.kind, 'solid');
  assert.equal(bg.from, '#ff5500');
  assert.ok(buildSvg('TAG', bg).includes('fill="#ff5500"'));
});

test('QC parses gradient hex pair', () => {
  const { text, bg } = parseBgFlag('FIRE --bg #ff0000,#ff8800');
  assert.equal(text, 'FIRE');
  assert.equal(bg.kind, 'gradient');
  assert.equal(bg.from, '#ff0000');
  assert.equal(bg.to, '#ff8800');
});

test('QC ignores invalid bg values and keeps them in the text', () => {
  const { text, bg } = parseBgFlag('SALE --bg notacolor');
  assert.equal(text, 'SALE --bg notacolor');
  assert.equal(bg.kind, 'transparent');
});

test('QC --bg flag works without spaces via = form', () => {
  const { text, bg } = parseBgFlag('OMEGA --bg=mono');
  assert.equal(text, 'OMEGA');
  assert.equal(bg.label, 'mono');
});

// ── TG — link parsing ───────────────────────────────────────

test('TG parses addstickers link with selection', () => {
  const ref = parseTgLink('https://t.me/addstickers/StickerPackName 3');
  assert.deepEqual(ref, { kind: 'pack', packName: 'StickerPackName', selection: 3 });
});

test('TG parses addstickers link without selection', () => {
  const ref = parseTgLink('t.me/addstickers/StickerPackName');
  assert.equal(ref?.kind, 'pack');
  assert.equal(ref?.packName, 'StickerPackName');
  assert.equal(ref?.selection, undefined);
});

test('TG parses bare pack name', () => {
  const ref = parseTgLink('StickerPackName');
  assert.equal(ref?.kind, 'pack');
  assert.equal(ref?.packName, 'StickerPackName');
});

test('TG parses telegram.me and tg:// forms', () => {
  assert.equal(parseTgLink('telegram.me/addstickers/FooBar')?.packName, 'FooBar');
  assert.equal(parseTgLink('tg://addstickers?set=FooBar')?.packName, 'FooBar');
});

test('TG parses individual post links (t.me/<channel>/<id>)', () => {
  const ref = parseTgLink('https://t.me/stickerpack/7');
  assert.deepEqual(ref, { kind: 'post', username: 'stickerpack', postId: '7' });
});

test('TG parses t.me/s/ post links too', () => {
  const ref = parseTgLink('https://t.me/s/stickerpack/42?single');
  assert.deepEqual(ref, { kind: 'post', username: 'stickerpack', postId: '42' });
});

test('TG rejects non-sticker links', () => {
  assert.equal(parseTgLink('https://t.me/randomchannel/abc'), null);
  assert.equal(parseTgLink('https://example.com'), null);
  assert.equal(parseTgLink(''), null);
  assert.equal(parseTgLink('   '), null);
});

test('TG selection is clamped to >= 1', () => {
  assert.equal(parseTgLink('https://t.me/addstickers/Pack 0')?.selection, 1);
});

// ── TG — post feed media extraction ─────────────────────────

test('TG extractPostMedia finds animated tgs source', () => {
  const html = `<div data-post="mychan/9"><source type="application/x-tgsticker" srcset="https://cdn4.telesco.pe/file/sticker.tgs?token=abc123"></div>`;
  const media = extractPostMedia(html, 'mychan', '9');
  assert.deepEqual(media, { kind: 'animated', url: 'https://cdn4.telesco.pe/file/sticker.tgs?token=abc123' });
});

test('TG extractPostMedia finds video webm', () => {
  const html = `<div data-post="mychan/9"><video class="js-videosticker_video" src="https://cdn4.telesco.pe/file/xx.webm?token=qq"></video></div>`;
  const media = extractPostMedia(html, 'mychan', '9');
  assert.deepEqual(media, { kind: 'video', url: 'https://cdn4.telesco.pe/file/xx.webm?token=qq' });
});

test('TG extractPostMedia finds static webp', () => {
  const html = `<div data-post="mychan/9"><img src="https://cdn4.telesco.pe/file/zz.webp?token=rr"></div>`;
  const media = extractPostMedia(html, 'mychan', '9');
  assert.deepEqual(media, { kind: 'static', url: 'https://cdn4.telesco.pe/file/zz.webp?token=rr' });
});

test('TG extractPostMedia returns null when post or media missing', () => {
  assert.equal(extractPostMedia('<div data-post="mychan/1"></div>', 'mychan', '99'), null);
  assert.equal(extractPostMedia('<div>nothing here</div>', 'mychan', '9'), null);
});

test('TG extractPostMedia never leaks media from neighbouring posts', () => {
  // post 8 is a video; the FOLLOWING post 10 is animated tgs. Extraction must
  // stay bounded to post 8's own block and return the video.
  const html =
    '<div data-post="mychan/8"><video class="js-videosticker_video" src="https://cdn4.telesco.pe/file/xx.webm?token=vv"></video></div>' +
    '<div data-post="mychan/10"><source type="application/x-tgsticker" srcset="https://cdn4.telesco.pe/file/sticker.tgs?token=tt"></div>';
  const media = extractPostMedia(html, 'mychan', '8');
  assert.deepEqual(media, { kind: 'video', url: 'https://cdn4.telesco.pe/file/xx.webm?token=vv' });
});

// ── Animated WebP detection ────────────────────────────────

function makeWebP(chunks: { fourCC: string; data: Buffer }[]): Buffer {
  const chunkBuffers = chunks.map(({ fourCC, data }) => {
    const header = Buffer.alloc(8);
    header.write(fourCC, 0, 'ascii');
    header.writeUInt32LE(data.length, 4);
    const body = Buffer.concat([header, data]);
    return body.length % 2 === 0 ? body : Buffer.concat([body, Buffer.from([0x00])]);
  });
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + chunkBuffers.reduce((n, c) => n + c.length, 0), 4);
  riff.write('WEBP', 8, 'ascii');
  return Buffer.concat([riff, ...chunkBuffers]);
}

function vp8x(animated: boolean): Buffer {
  const flags = Buffer.alloc(10);
  flags.writeUInt8(animated ? 0x02 : 0x00, 0); // bit 1 = animation
  return flags;
}

test('isAnimatedWebP detects static VP8X as not animated', () => {
  const buffer = makeWebP([{ fourCC: 'VP8X', data: vp8x(false) }]);
  assert.equal(isAnimatedWebP(buffer), false);
});

test('isAnimatedWebP detects animated VP8X (animation flag set)', () => {
  const buffer = makeWebP([{ fourCC: 'VP8X', data: vp8x(true) }]);
  assert.equal(isAnimatedWebP(buffer), true);
});

test('isAnimatedWebP detects ANIM chunk as animated', () => {
  const buffer = makeWebP([{ fourCC: 'ANIM', data: Buffer.from([0, 0, 0, 0, 0, 0]) }]);
  assert.equal(isAnimatedWebP(buffer), true);
});

test('isAnimatedWebP returns false for non-webp buffers', () => {
  assert.equal(isAnimatedWebP(Buffer.from('not a webp at all')), false);
  assert.equal(isAnimatedWebP(Buffer.from('RIFFxxxxWEBP')), false); // truncated
  assert.equal(isAnimatedWebP(Buffer.alloc(0)), false);
});

// ── Registry integration ────────────────────────────────────

test('qc and tg are registered commands', () => {
  assert.ok(ALL_COMMANDS.includes('qc'));
  assert.ok(ALL_COMMANDS.includes('tg'));
});

test('qc and tg appear in the menu catalog under STICKER ENGINE', () => {
  assert.equal(MENU_CATALOG.qc?.section, '🎨 STICKER ENGINE');
  assert.equal(MENU_CATALOG.tg?.section, '🎨 STICKER ENGINE');
});

test('tg menu entry documents the whole-pack download flow', () => {
  assert.match(MENU_CATALOG.tg!.desc, /whole Telegram sticker pack/i);
  assert.match(MENU_CATALOG.tg!.usage!, /EVERY sticker/i);
  assert.match(MENU_CATALOG.tg!.usage!, /Total stickers found/i);
});

test('tg pack links without a number mean send-all (selection undefined)', () => {
  const ref = parseTgLink('https://t.me/addstickers/StickerPackName');
  assert.equal(ref?.kind, 'pack');
  assert.equal(ref?.selection, undefined); // → downloadPackAll
  const withNumber = parseTgLink('https://t.me/addstickers/StickerPackName 3');
  assert.equal(withNumber?.selection, 3); // → single downloadPackSticker
});
