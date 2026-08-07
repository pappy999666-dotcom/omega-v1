import { test } from 'node:test';
import assert from 'node:assert';
import { ALL_COMMANDS } from '../src/whatsapp/command-parser.js';
import {
  MAIN_NAV,
  GROUP_NAV,
  MENU_CATALOG,
  categoryPageButtons,
  navCommandLines,
  renderNavCategoryPage,
  renderNavHub,
} from '../src/whatsapp/menu-registry.js';
import { ANTI_TARGET_SCOPE } from '../src/whatsapp/anti-system/index.js';
import {
  fetchGroupMeta,
  isAdminJid,
  isProtectedJid,
  patchGroupMetaCache,
} from '../src/whatsapp/utils/group-permissions.js';

test('navigation hub exposes complete category navigation', () => {
  const text = renderNavHub('.', 'main', ALL_COMMANDS);

  assert.deepStrictEqual(
    MAIN_NAV.map((category) => category.label),
    ['Pair', 'Help', 'Status', 'Messaging', 'Group', 'Promotion', 'Anti-System', 'Info', 'Utilities', 'Sessions', 'Configuration']
  );
  assert.match(text, /^𝗢 𝗠 𝗘 𝗚 𝗔  𝄜  𝗡 𝗔 𝗩 𝗜 𝗚 𝗔 𝗧 𝗜 𝑶 𝑵/);
  assert.match(text, /Status: Online  •  Prefix: \./);
  assert.match(text, /✦ 🔗 Pair\nUse any prefix then pair your number\.\nExample:\n23470288288288/);

  for (const nav of MAIN_NAV.slice(1)) {
    const count = navCommandLines('.', nav, 'main', ALL_COMMANDS).length;
    assert.match(text, new RegExp(`✦ ${nav.emoji} ${nav.label} ── \\[${count}\\]`));
  }

  assert.match(text, /✦ 📖 Help/);
  assert.match(text, /✦ 📲 Status/);
  assert.doesNotMatch(text, /✦ 🖥️ System|✦ ⚙️ Settings/);
  assert.match(text, /💎 Premium:\nUnlimited Bucket Capacity\./);
  assert.match(text, /· · ——— 𝗢𝗠𝗘𝗚𝗔 • 𝗩𝟭 ——— · ·$/);
});

test('status category lists every registered status-related command and paginates it', () => {
  const status = MAIN_NAV.find((nav) => nav.id === 'status');
  assert.ok(status);

  const lines = navCommandLines('.', status!, 'main', ALL_COMMANDS);
  const actualNames = new Set(lines.map((line) => line.name));
  // `ALL_COMMANDS` is the parser's runtime authority; only registered catalog
  // entries are allowed to reach an interactive command sheet.
  const registeredExpectedNames = new Set(
    Object.entries(MENU_CATALOG)
      .filter(([name, entry]) => !entry.hidden && entry.navCategory === 'status' && ALL_COMMANDS.includes(name as typeof ALL_COMMANDS[number]))
      .map(([name]) => name)
  );
  assert.deepStrictEqual(actualNames, registeredExpectedNames);
  for (const command of [
    'godcast', 'statusdesign', 'settheme', 'smedia', 'gstatus', 'togstatus',
    'togstatusx', 'allstatus', 'allgstatus', 'allstatusx', 'pstatus',
    'sstatus', 'autosend', 'autodstatus', 'autostatusreact', 'antigstatus',
    'spam', 'stopspam', 'stop', 'vv', 'vvdm', 'autovv', 'antidelete',
  ]) {
    assert.ok(actualNames.has(command), `missing status command: ${command}`);
  }

  const { text, totalPages } = renderNavCategoryPage('.', 'status', 1, 'main', ALL_COMMANDS);
  assert.ok(totalPages > 1);
  assert.ok(text.startsWith('📲 𝗦 𝗧 𝗔 𝗧 𝗨 𝗦  𝄜  𝟭 / '));
  assert.match(text, /✦ 𝗴𝗼𝗱𝗰𝗮𝘀𝘁/);

  const renderedPages = Array.from({ length: totalPages }, (_, index) =>
    renderNavCategoryPage('.', 'status', index + 1, 'main', ALL_COMMANDS).text
  ).join('\n');
  assert.match(renderedPages, /✦ 𝗮𝗹𝗹𝘀𝘁𝗮𝘁𝘂𝘀 \[msg\] 💎/);
  assert.deepStrictEqual(
    categoryPageButtons('main', 'status', 2, totalPages).map((button) => JSON.parse(button.buttonParamsJson).id),
    ['menu:cat:m:status:1', 'menu:cat:m:status:3', 'menu:home:m']
  );
});

test('group Status exposes the same complete status command domain', () => {
  const status = GROUP_NAV.find((nav) => nav.id === 'status');
  assert.ok(status);
  const lines = navCommandLines('.', status!, 'group', ALL_COMMANDS);
  const actualNames = new Set(lines.map((line) => line.name));
  const expectedNames = new Set(
    Object.entries(MENU_CATALOG)
      .filter(([name, entry]) => !entry.hidden && entry.navCategory === 'status' && ALL_COMMANDS.includes(name as typeof ALL_COMMANDS[number]))
      .map(([name]) => name)
  );
  assert.deepStrictEqual(actualNames, expectedNames);
});

test('main navigation gives registered session and configuration commands a category', () => {
  for (const categoryId of ['sessions', 'config']) {
    const nav = MAIN_NAV.find((item) => item.id === categoryId);
    assert.ok(nav, `missing ${categoryId} category`);
    assert.ok(navCommandLines('.', nav!, 'main', ALL_COMMANDS).length > 0);
  }
});

test('normal message anti modules are member-only and admin guards are explicit', () => {
  assert.ok(Object.keys(ANTI_TARGET_SCOPE).length > 0);
  for (const [module, scope] of Object.entries(ANTI_TARGET_SCOPE)) {
    assert.strictEqual(scope, 'members', `${module} must not punish admins`);
  }
});

test('cached LID participant role changes follow phone-JID updates', async () => {
  const groupJid = '120363000000000001@g.us';
  const adminLid = '111222333@lid';
  const adminPhone = '2348012345678@s.whatsapp.net';
  const socket: any = {
    user: { id: '2348000000000@s.whatsapp.net' },
    groupMetadata: async () => ({
      participants: [
        { id: adminLid, admin: null, phoneNumber: '2348012345678' },
        { id: '2348000000000@s.whatsapp.net', admin: 'admin', phoneNumber: '2348000000000' },
      ],
    }),
  };

  const meta = await fetchGroupMeta(socket, groupJid, true);
  assert.ok(meta);
  patchGroupMetaCache(socket, groupJid, 'promote', [adminPhone]);
  assert.strictEqual(isAdminJid(meta.participants, adminPhone), true);
  patchGroupMetaCache(socket, groupJid, 'demote', [adminPhone]);
  assert.strictEqual(isAdminJid(meta.participants, adminPhone), false);
});

test('admin protection matches a phone sender to an admin LID participant', () => {
  const adminPhone = '2348012345678@s.whatsapp.net';
  const adminLid = '987654321@lid';
  const participants = [
    { id: adminLid, admin: 'admin' as const, phoneNumber: '2348012345678' },
    { id: '2348098765432@s.whatsapp.net', admin: null, phoneNumber: '2348098765432' },
  ];

  assert.strictEqual(isAdminJid(participants, adminPhone), true);
  assert.strictEqual(isAdminJid(participants, adminLid), true);
  assert.strictEqual(isAdminJid(participants, '2348012345678:7@s.whatsapp.net'), true);
  assert.strictEqual(isAdminJid(participants, '2348098765432@s.whatsapp.net'), false);
  assert.strictEqual(
    isProtectedJid({
      botJid: '2348000000000@s.whatsapp.net',
      botIsAdmin: true,
      participants,
      subject: 'Test',
    }, adminPhone),
    true
  );
});
