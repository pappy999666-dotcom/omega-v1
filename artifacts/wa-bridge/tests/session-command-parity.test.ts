import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_COMMANDS } from '../src/whatsapp/command-parser.js';
import { MENU_CATALOG, navCommandLines, MAIN_NAV } from '../src/whatsapp/menu-registry.js';
import { filterPendingRequestsByCountry } from '../src/whatsapp/utils/join-approval.js';

test('Telegram per-session controls are registered on WhatsApp without Join Manager/My Groups', () => {
  for (const command of [
    'setpfp', 'getpfp', 'removepfp', 'setname', 'setbio', 'wainfo',
    'creategc', 'collect', 'autopromo',
  ]) {
    assert.ok(ALL_COMMANDS.includes(command as typeof ALL_COMMANDS[number]), `missing ${command}`);
    assert.ok(MENU_CATALOG[command], `missing menu entry for ${command}`);
  }

  assert.ok(!ALL_COMMANDS.includes('joinmgr' as never));
  assert.ok(!ALL_COMMANDS.includes('mygroups' as never));
  for (const command of ['pendingjoin', 'approveall', 'rejectall', 'approveamt', 'approvecountry']) {
    assert.equal(MENU_CATALOG[command]?.hidden, true, `${command} should be command-only in WhatsApp menus`);
  }

  const config = MAIN_NAV.find((nav) => nav.id === 'config');
  assert.ok(config);
  const names = new Set(navCommandLines('.', config!, 'main', ALL_COMMANDS).map((line) => line.name));
  assert.ok(names.has('setpfp'));
  assert.ok(names.has('autopromo'));
  assert.ok(!names.has('joinmgr'));
  assert.ok(!names.has('mygroups'));
  assert.ok(!names.has('approveall'));
  assert.ok(!names.has('approvecountry'));
});

test('approvecountry fails closed for unresolved LIDs and matches explicit country phones', async () => {
  const requests = [
    { jid: 'known@s.whatsapp.net' },
    { jid: 'unknown@lid' },
    { jid: 'lid-with-phone@lid', phoneNumber: '+2348012345678' },
  ];
  const participants = [
    { id: 'known@s.whatsapp.net', admin: null },
    { id: 'unknown@lid', admin: null },
  ];
  const matched = await filterPendingRequestsByCountry(
    { user: { id: 'bot@s.whatsapp.net' } } as any,
    requests,
    participants,
    '+234'
  );
  assert.deepEqual(matched.map((request) => request.jid), ['lid-with-phone@lid']);
});

test('approvecountry resolves a LID through its own participant phone mapping', async () => {
  const matched = await filterPendingRequestsByCountry(
    {} as any,
    [{ jid: '150268759003140@lid' }],
    [{ id: '150268759003140@lid', admin: null, phoneNumber: '2348012345678' }],
    '234'
  );
  assert.deepEqual(matched.map((request) => request.jid), ['150268759003140@lid']);
});
