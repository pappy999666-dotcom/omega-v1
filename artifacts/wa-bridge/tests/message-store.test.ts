// Targeted unit tests for src/whatsapp/message-store.ts
// Run: node --import tsx --test tests/message-store.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  markSeen,
  rememberMessage,
  loadMessage,
  upsertContacts,
  lookupContact,
  contactName,
  setPresence,
  getOnlineUsers,
  noteReaction,
  reactionsFor,
  clearStores,
} from '../src/whatsapp/message-store.js';
import type { WebMessageInfo } from '../src/whatsapp/baileys-types.js';

const SID = 'test-session';

test.beforeEach(() => clearStores(SID));

// ── Upsert dedupe ──────────────────────────────────────────

test('markSeen dedupes within the window and accepts new ids', () => {
  assert.equal(markSeen(SID, 'msg-1'), true, 'first occurrence is new');
  assert.equal(markSeen(SID, 'msg-1'), false, 're-delivery is a duplicate');
  assert.equal(markSeen(SID, 'msg-2'), true, 'different id is new');
  assert.equal(markSeen(SID, ''), false, 'empty id never dedupes true');
  assert.equal(markSeen(SID, null), false);
});

// ── Message store (getMessage backing) ─────────────────────

test('rememberMessage/loadMessage round-trips by remoteJid:id', () => {
  const msg: WebMessageInfo = {
    key: { remoteJid: '123@g.us', fromMe: false, id: 'wa-id-42' },
    message: { conversation: 'stored' },
    pushName: 'Daytona',
  };
  rememberMessage(SID, msg);
  const loaded = loadMessage(SID, '123@g.us', 'wa-id-42');
  assert.ok(loaded, 'message should be loadable');
  assert.equal(loaded?.message?.conversation, 'stored');
  assert.equal(loadMessage(SID, '123@g.us', 'nope'), null, 'unknown id → null');
  assert.equal(loadMessage(SID, null, 'x'), null);
});

test('message store scopes by remoteJid', () => {
  const a: WebMessageInfo = { key: { remoteJid: 'g1@g.us', fromMe: false, id: 'same' }, message: { conversation: 'in-g1' } };
  rememberMessage(SID, a);
  assert.equal(loadMessage(SID, 'g2@g.us', 'same'), null);
});

// ── Contact store (LID→phone fallback) ─────────────────────

test('upsertContacts stores by id and indexes by lid', () => {
  upsertContacts(SID, [
    { id: '123@s.whatsapp.net', name: 'Alice', notify: 'alice-device', lid: '456@lid' },
  ]);
  assert.equal(lookupContact(SID, '123@s.whatsapp.net')?.name, 'Alice');
  assert.equal(contactName(SID, '123@s.whatsapp.net'), 'Alice');
  // Lookup by LID returns the indexed copy
  const byLid = lookupContact(SID, '456@lid');
  assert.ok(byLid, 'lid-indexed contact should exist');
  assert.equal(byLid?.phoneNumber, undefined); // lid copy only carries available fields
  assert.equal(contactName(SID, 'unknown@lid'), null);
});

test('upsertContacts merges rather than replaces', () => {
  upsertContacts(SID, [{ id: '9@s.whatsapp.net', name: 'Bob', phoneNumber: '9' }]);
  upsertContacts(SID, [{ id: '9@s.whatsapp.net', notify: 'bob-phone' }]);
  const c = lookupContact(SID, '9@s.whatsapp.net');
  assert.equal(c?.name, 'Bob');
  assert.equal(c?.notify, 'bob-phone');
});

// ── Presence tracking ──────────────────────────────────────

test('setPresence tracks online users', () => {
  setPresence(SID, '1@s.whatsapp.net', true);
  setPresence(SID, '2@s.whatsapp.net', true);
  setPresence(SID, '2@s.whatsapp.net', false);
  assert.deepEqual(getOnlineUsers(SID), ['1@s.whatsapp.net']);
});

// ── Reactions ──────────────────────────────────────────────

test('noteReaction/reactionsFor per message + per sender', () => {
  noteReaction(SID, 'msg-9', '1@s.whatsapp.net', '🔥');
  noteReaction(SID, 'msg-9', '2@s.whatsapp.net', '❤️');
  noteReaction(SID, 'msg-9', '1@s.whatsapp.net', '👍'); // overwrites same sender
  const all = reactionsFor(SID, 'msg-9');
  assert.equal(all.get('1@s.whatsapp.net'), '👍');
  assert.equal(all.get('2@s.whatsapp.net'), '❤️');
  assert.equal(reactionsFor(SID, 'unseen').size, 0);
});
