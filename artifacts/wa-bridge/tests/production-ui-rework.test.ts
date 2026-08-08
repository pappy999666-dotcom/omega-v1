import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_COMMANDS } from '../src/whatsapp/command-parser.js';
import {
  MAIN_NAV,
  MENU_CATALOG,
  navCommandLines,
  navHubButtons,
  renderNavCategoryPage,
  renderNavHub,
} from '../src/whatsapp/menu-registry.js';
import { generateWhatsAppHelp } from '../src/services/help.js';
import { config, error, mini, success } from '../src/services/ResponseEngine.js';

test('WhatsApp dashboard has exactly four dynamic routes', () => {
  assert.deepEqual(MAIN_NAV.map((route) => route.id), ['group', 'status', 'game', 'extras']);
  const text = renderNavHub('.', 'main', ALL_COMMANDS, { userName: 'Operator', pairedAt: Date.now() - 2 * 86_400_000 });
  for (const route of MAIN_NAV) {
    const count = navCommandLines('.', route, 'main', ALL_COMMANDS).length;
    assert.match(text, new RegExp(`✦ ${route.emoji} ${route.label} ── \\[${count}\\]`));
  }
  assert.match(text, /╭─── ⟡ 𝗢𝗠𝗘𝗚𝗔-𝗩𝟭 𝗠𝗘𝗡𝗨 ⟡ ───╮/);
  assert.match(text, /╰── 💎 𝗣𝗿𝗲𝗺𝗶𝘂𝗺 𝗘𝗻𝗮𝗯𝗹𝗲𝗱 ──╯/);
  assert.equal(navHubButtons('main').length, 4);
});

test('category route renders all live commands in one response', () => {
  for (const route of MAIN_NAV) {
    const lines = navCommandLines('.', route, 'main', ALL_COMMANDS);
    const rendered = renderNavCategoryPage('.', route.id, 1, 'main', ALL_COMMANDS);
    assert.equal(rendered.totalPages, 1);
    for (const line of lines) {
      assert.match(rendered.text, new RegExp(line.desc.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
    }
  }
});

test('every registered command has help metadata and pair help is detailed', () => {
  for (const command of ALL_COMMANDS) {
    const entry = MENU_CATALOG[command];
    assert.ok(entry, `missing registry entry: ${command}`);
    assert.ok(entry.desc, `missing description: ${command}`);
    assert.ok(entry.syntax, `missing usage: ${command}`);
  }
  const help = generateWhatsAppHelp('.', false, 'pair', ALL_COMMANDS);
  assert.match(help, /𝗖𝗼𝗺𝗺𝗮𝗻𝗱 : pair/);
  assert.match(help, /𝗗𝗲𝘀𝗰𝗿𝗶𝗽𝘁𝗶𝗼𝗻/);
  assert.match(help, /𝗨𝘀𝗮𝗴𝗲/);
  assert.match(help, /𝗣𝗮𝗿𝗮𝗺𝗲𝘁𝗲𝗿𝘀/);
  assert.match(help, /𝗘𝘅𝗮𝗺𝗽𝗹𝗲𝘀/);
  assert.match(help, /𝗣𝗲𝗿𝗺𝗶𝘀𝘀𝗶𝗼𝗻/);
});

test('help intro and invalid command are inspection responses', () => {
  assert.match(generateWhatsAppHelp('.', false), /\.help <command>/);
  const invalid = generateWhatsAppHelp('.', false, 'randomcommand', ALL_COMMANDS);
  assert.match(invalid, /𝗖𝗼𝗺𝗺𝗮𝗻𝗱 𝗡𝗼𝘁 𝗙𝗼𝘂𝗻𝗱/);
  assert.match(invalid, /\.help/);
});

test('compact renderer exposes mini, success, config, and error forms', () => {
  assert.equal(mini('Status Sent', 'Target: Main Chat'), '✅ Status Sent\n└ Target: Main Chat');
  assert.equal(success('Changed', undefined, [['Prefix', '!']]), '✅ Changed\n└ Prefix: !');
  assert.equal(config('AntiLink', [['Mode', 'Delete'], ['Status', 'Enabled']]), '⚙️ AntiLink\n└ Mode: Delete\n└ Status: Enabled');
  assert.equal(error('Failed', 'fetch failed', [['Command', 'cs']]), '❌ Failed\n└ fetch failed\n└ Command: cs');
});
