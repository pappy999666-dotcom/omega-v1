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

test('navigation hub exposes exactly four complete routes', () => {
  const text = renderNavHub('.', 'main', ALL_COMMANDS);
  assert.deepStrictEqual(MAIN_NAV.map((category) => category.label), ['Group', 'Status', 'Game', 'Extras']);
  assert.match(text, /^╭─── ⟡ 𝗢𝗠𝗘𝗚𝗔-𝗩𝟭 𝗠𝗘𝗡𝗨/);
  for (const nav of MAIN_NAV) {
    const count = navCommandLines('.', nav, 'main', ALL_COMMANDS).length;
    assert.match(text, new RegExp(`✦ ${nav.emoji} ${nav.label} ── \\[${count}\\]`));
  }
  assert.match(text, /╰── 💎 𝗣𝗿𝗲𝗺𝗶𝘂𝗺 𝗘𝗻𝗮𝗯𝗹𝗲𝗱 ──╯/);
});

test('status category lists every registered status command in one response', () => {
  const status = MAIN_NAV.find((nav) => nav.id === 'status');
  assert.ok(status);
  const lines = navCommandLines('.', status!, 'main', ALL_COMMANDS);
  const expected = new Set(
    ALL_COMMANDS.filter((name) => {
      const entry = MENU_CATALOG[name];
      return Boolean(entry && !entry.hidden && (entry.navCategory === 'status' || /^(?:tochat|tochatx|togstatus|togstatusx|allchat|allstatus|allgstatus|allstatusx|spam|stopspam|stop)$/u.test(name)));
    })
  );
  assert.deepStrictEqual(new Set(lines.map((line) => line.name)), expected);
  const rendered = renderNavCategoryPage('.', 'status', 1, 'main', ALL_COMMANDS);
  assert.equal(rendered.totalPages, 1);
  for (const line of lines) {
    assert.match(rendered.text, new RegExp(line.desc.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  }
  assert.deepStrictEqual(
    categoryPageButtons('main', 'status', 1, 1).map((button) => JSON.parse(button.buttonParamsJson).id),
    ['menu:home:m']
  );
});

test('group route uses the requested moderation/anti layout and admin badges', () => {
  const group = GROUP_NAV.find((nav) => nav.id === 'group');
  assert.ok(group);
  const rendered = renderNavCategoryPage('.', 'group', 1, 'main', ALL_COMMANDS);
  assert.equal(rendered.totalPages, 1);
  assert.match(rendered.text, /\[⚔️\] 𝗚𝗥𝗢𝗨𝗣 𝗠𝗢𝗗𝗘𝗥𝗔𝗧𝗜𝗢𝗡/);
  assert.match(rendered.text, /\[🛡️\] 𝗔𝗡𝗧𝗜-𝗦𝗬𝗦𝗧𝗘𝗠/);
  assert.match(rendered.text, /✦ 𝗸𝗶𝗰𝗸  \[👑 Admin\]/);
  assert.match(rendered.text, /✦ 𝗽𝗿𝗼𝗺𝗼𝘁𝗲  \[👑 Admin\]/);
  assert.match(rendered.text, /✦ 𝗮𝗻𝘁𝗶𝗹𝗶𝗻𝗸 <kick\|warn N\|delete\|off>/);
  assert.doesNotMatch(rendered.text, /𝕻𝕬𝕻𝕻𝖄/);
});

test('group target shares the four routes and complete status discovery', () => {
  assert.deepStrictEqual(GROUP_NAV.map((nav) => nav.id), MAIN_NAV.map((nav) => nav.id));
  const status = GROUP_NAV.find((nav) => nav.id === 'status');
  assert.ok(status);
  assert.ok(navCommandLines('.', status!, 'group', ALL_COMMANDS).length > 0);
});

test('all registered commands have catalog entries', () => {
  for (const command of ALL_COMMANDS) assert.ok(MENU_CATALOG[command], `missing catalog entry: ${command}`);
});

test('normal message anti modules are member-only and admin guards are explicit', () => {
  assert.ok(Object.keys(ANTI_TARGET_SCOPE).length > 0);
  for (const [module, scope] of Object.entries(ANTI_TARGET_SCOPE)) {
    assert.strictEqual(scope, 'members', `${module} must not punish admins`);
  }
});

test('cached LID participant role changes follow phone-JID updates', async () => {
  const groupJid = '120363000000000001@g.us';
  const adminPhone = '2348012345678@s.whatsapp.net';
  const socket: any = {
    user: { id: '2348000000000@s.whatsapp.net' },
    groupMetadata: async () => ({
      participants: [
        { id: '111222333@lid', admin: null, phoneNumber: '2348012345678' },
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
  assert.strictEqual(isProtectedJid({ botJid: '2348000000000@s.whatsapp.net', botIsAdmin: true, participants, subject: 'Test' }, adminPhone), true);
});
