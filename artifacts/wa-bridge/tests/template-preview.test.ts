import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderTemplate,
  hasTemplateVariable,
  configuredTimeZone,
  currentDateString,
  currentTimeString,
} from '../src/utils/response-engine.js';

// ── renderTemplate: synchronous variable substitution with a fake socket ──
const fakeSocket = {
  groupMetadata: async () => ({ subject: 'Test Group', participants: [] }),
} as any;

test('substitutes @mention with the sender phone', async () => {
  const out = await renderTemplate('Welcome @mention!', {
    senderJid: '15550001111@s.whatsapp.net',
    gcName: 'TG',
    socket: fakeSocket,
    groupJid: '1@g.us',
  });
  assert.ok(out.includes('@15550001111'));
});

test('substitutes &gcname with the group name', async () => {
  const out = await renderTemplate('In &gcname', {
    senderJid: 'x@s.whatsapp.net',
    gcName: 'Omega Group',
    socket: fakeSocket,
    groupJid: '1@g.us',
  });
  assert.ok(out.includes('Omega Group'));
});

test('substitutes &date and &time with tz-correct values', async () => {
  const out = await renderTemplate('On &date at &time', {
    senderJid: 'x@s.whatsapp.net',
    gcName: 'G',
    socket: fakeSocket,
    groupJid: '1@g.us',
  });
  assert.match(out, /On .{6,} at \d{2}:\d{2}/);
});

test('resolves &membercount and &admincount from group metadata', async () => {
  const socket = {
    groupMetadata: async () => ({
      subject: 'G',
      participants: [
        { id: 'a@s.whatsapp.net', admin: 'admin' },
        { id: 'b@s.whatsapp.net' },
        { id: 'c@s.whatsapp.net', admin: 'superadmin' },
      ],
    }),
  } as any;
  const out = await renderTemplate('Members: &membercount · Admins: &admincount', {
    senderJid: 'x@s.whatsapp.net',
    gcName: 'G',
    socket,
    groupJid: '1@g.us',
  });
  assert.ok(out.includes('Members: 3'));
  assert.ok(out.includes('Admins: 2'));
});

test('gracefully ignores unsupported variables (leaves token as-is or empty, never throws)', async () => {
  const out = await renderTemplate('Hi &unknownvar @missing', {
    senderJid: 'x@s.whatsapp.net',
    gcName: 'G',
    socket: fakeSocket,
    groupJid: '1@g.us',
  });
  // Must not throw and must keep rendering the known parts
  assert.ok(out.includes('Hi'));
});

test('strips &pp and &getpp from text (media is attached by callers)', async () => {
  const out = await renderTemplate('Photo: &pp and &getpp', {
    senderJid: 'x@s.whatsapp.net',
    gcName: 'G',
    socket: fakeSocket,
    groupJid: '1@g.us',
  });
  assert.ok(!out.includes('&pp'));
  assert.ok(!out.includes('&getpp'));
});

// ── hasTemplateVariable ──
test('hasTemplateVariable detects &pp case-insensitively', () => {
  assert.equal(hasTemplateVariable('Welcome &pp', 'pp'), true);
  assert.equal(hasTemplateVariable('Welcome &PP', 'pp'), true);
  assert.equal(hasTemplateVariable('Welcome @mention', 'pp'), false);
  assert.equal(hasTemplateVariable('', 'pp'), false);
});

test('hasTemplateVariable detects &time and &date', () => {
  assert.equal(hasTemplateVariable('At &time today', 'time'), true);
  assert.equal(hasTemplateVariable('On &date', 'date'), true);
});

// ── Timezone helpers ──
test('configuredTimeZone honors OMEGA_TZ env', () => {
  const before = process.env.OMEGA_TZ;
  process.env.OMEGA_TZ = 'Europe/Berlin';
  assert.equal(configuredTimeZone(), 'Europe/Berlin');
  if (before === undefined) delete process.env.OMEGA_TZ;
  else process.env.OMEGA_TZ = before;
});

test('currentDateString / currentTimeString never throw and return non-empty', () => {
  assert.ok(currentDateString().length > 0);
  assert.match(currentTimeString(), /\d{2}:\d{2}/);
});
