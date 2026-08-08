import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSvg, layoutLines } from '../src/whatsapp/commands/qc-sticker.js';
import { parseTgLink } from '../src/whatsapp/commands/tg-sticker.js';
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

// ── TG — link parsing ───────────────────────────────────────

test('TG parses addstickers link with selection', () => {
  const ref = parseTgLink('https://t.me/addstickers/StickerPackName 3');
  assert.deepEqual(ref, { packName: 'StickerPackName', selection: 3 });
});

test('TG parses addstickers link without selection', () => {
  const ref = parseTgLink('t.me/addstickers/StickerPackName');
  assert.equal(ref?.packName, 'StickerPackName');
  assert.equal(ref?.selection, undefined);
});

test('TG parses bare pack name', () => {
  const ref = parseTgLink('StickerPackName');
  assert.equal(ref?.packName, 'StickerPackName');
});

test('TG parses telegram.me and tg:// forms', () => {
  assert.equal(parseTgLink('telegram.me/addstickers/FooBar')?.packName, 'FooBar');
  assert.equal(parseTgLink('tg://addstickers?set=FooBar')?.packName, 'FooBar');
});

test('TG rejects non-sticker links', () => {
  assert.equal(parseTgLink('https://t.me/randomchannel/123'), null);
  assert.equal(parseTgLink('https://example.com'), null);
  assert.equal(parseTgLink(''), null);
  assert.equal(parseTgLink('   '), null);
});

test('TG selection is clamped to >= 1', () => {
  assert.equal(parseTgLink('https://t.me/addstickers/Pack 0')?.selection, 1);
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
