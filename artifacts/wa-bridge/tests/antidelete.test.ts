// Targeted tests for the AntiDelete recovery engine
// Run: node --import tsx --test tests/antidelete.test.ts
//
// Mirrors the installed @crysnovax/baileys fork's REAL delete-for-everyone
// delivery (Utils/process-message.js REVOKE case):
//   ev.emit('messages.update', [{
//     key: { ...message.key, id: protocolMsg.key.id },   // <-- ORIGINAL id
//     update: { message: null, messageStubType: REVOKE }
//   }]);
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cacheMessage,
  handleDeletedKey,
  cmdAntiDelete,
  setChatEngineConfig,
  getChatEngineConfig,
} from '../src/whatsapp/personal-engine.js';
import type { WebMessageInfo } from '../src/whatsapp/baileys-types.js';

const TG = 'test-tg-antidelete';
const SESSION = 'test-session-antidelete';
const GROUP = '120363999999999999@g.us';
const SELF = '2348012345678@s.whatsapp.net';
const DEST = '120363111111111111@g.us';

function makeMsg(id: string, text: string, opts?: { fromMe?: boolean }): WebMessageInfo {
  return {
    key: { remoteJid: GROUP, id, fromMe: opts?.fromMe ?? false },
    message: { extendedTextMessage: { text, contextInfo: {} } },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: 'Sender Name',
  } as unknown as WebMessageInfo;
}

function makeSocket(sendLog: Array<{ jid: string; content: Record<string, unknown> }>) {
  return {
    user: { id: '2348012345678:6@s.whatsapp.net' },
    sendMessage: async (jid: string, content: Record<string, unknown>) => {
      sendLog.push({ jid, content });
      return { key: { id: `sent-${sendLog.length}` } };
    },
    groupMetadata: async () => ({ subject: 'Test Group' }),
    groupGetInviteInfo: async () => ({ id: GROUP }),
  } as unknown as any;
}

test('cmdAntiDelete sets and persists all four modes', async () => {
  const socket = makeSocket([]);
  const prefix = '.';

  const on = await cmdAntiDelete(socket, TG, SESSION, GROUP, ['on'], prefix);
  assert.match(on, /ANTI DELETE/);
  assert.equal(getChatEngineConfig(TG, SESSION, GROUP).antiDelete?.mode, 'on');

  const dm = await cmdAntiDelete(socket, TG, SESSION, GROUP, ['dm'], prefix);
  assert.match(dm, /ANTI DELETE/);
  assert.equal(getChatEngineConfig(TG, SESSION, GROUP).antiDelete?.mode, 'dm');

  const link = await cmdAntiDelete(socket, TG, SESSION, GROUP, ['link', DEST], prefix);
  assert.match(link, /ANTI DELETE/);
  assert.equal(getChatEngineConfig(TG, SESSION, GROUP).antiDelete?.mode, 'link');
  assert.equal(getChatEngineConfig(TG, SESSION, GROUP).antiDelete?.link, DEST);

  // Invalid destination rejected
  const bad = await cmdAntiDelete(socket, TG, SESSION, GROUP, ['link', 'not-a-dest'], prefix);
  assert.match(bad, /Invalid destination/);

  const off = await cmdAntiDelete(socket, TG, SESSION, GROUP, ['off'], prefix);
  assert.match(off, /ANTI DELETE/);
  assert.equal(getChatEngineConfig(TG, SESSION, GROUP).antiDelete?.mode, 'off');
});

test('mode ON: recovers the cached message into the same chat via the fork revoke key', async () => {
  const sendLog: Array<{ jid: string; content: Record<string, unknown> }> = [];
  const socket = makeSocket(sendLog);
  setChatEngineConfig(TG, SESSION, GROUP, { antiDelete: { mode: 'on' } });

  const origId = 'ORIGINAL-ABC-123';
  cacheMessage(SESSION, makeMsg(origId, 'classified content'));
  // Fork revoke payload: top-level key carries the ORIGINAL message id.
  await handleDeletedKey(socket, SESSION, TG, { remoteJid: GROUP, id: origId });

  assert.equal(sendLog.length, 1);
  assert.equal(sendLog[0]!.jid, GROUP);
  const text = sendLog[0]!.content['text'] as string;
  assert.match(text, /DELETED MESSAGE RECOVERED/);
  assert.match(text, /Chat: Test Group/);
  assert.match(text, /Sender: Sender Name/);
  assert.match(text, /classified content/);
});

test('mode DM: recovers to the self JID, never the chat', async () => {
  const sendLog: Array<{ jid: string; content: Record<string, unknown> }> = [];
  const socket = makeSocket(sendLog);
  setChatEngineConfig(TG, SESSION, GROUP, { antiDelete: { mode: 'dm' } });

  const origId = 'ORIGINAL-DM-456';
  cacheMessage(SESSION, makeMsg(origId, 'private content'));
  await handleDeletedKey(socket, SESSION, TG, { remoteJid: GROUP, id: origId });

  assert.equal(sendLog.length, 1);
  assert.equal(sendLog[0]!.jid, SELF);
});

test('mode LINK: forwards to the configured destination group', async () => {
  const sendLog: Array<{ jid: string; content: Record<string, unknown> }> = [];
  const socket = makeSocket(sendLog);
  setChatEngineConfig(TG, SESSION, GROUP, { antiDelete: { mode: 'link', link: DEST } });

  const origId = 'ORIGINAL-LINK-789';
  cacheMessage(SESSION, makeMsg(origId, 'forwarded content'));
  await handleDeletedKey(socket, SESSION, TG, { remoteJid: GROUP, id: origId });

  assert.equal(sendLog.length, 1);
  assert.equal(sendLog[0]!.jid, DEST);
});

test('mode OFF: nothing is recovered or sent', async () => {
  const sendLog: Array<{ jid: string; content: Record<string, unknown> }> = [];
  const socket = makeSocket(sendLog);
  setChatEngineConfig(TG, SESSION, GROUP, { antiDelete: { mode: 'off' } });

  const origId = 'ORIGINAL-OFF-000';
  cacheMessage(SESSION, makeMsg(origId, 'should never resend'));
  await handleDeletedKey(socket, SESSION, TG, { remoteJid: GROUP, id: origId });

  assert.equal(sendLog.length, 0);
});

test('never resurrects the bot own deleted messages', async () => {
  const sendLog: Array<{ jid: string; content: Record<string, unknown> }> = [];
  const socket = makeSocket(sendLog);
  setChatEngineConfig(TG, SESSION, GROUP, { antiDelete: { mode: 'on' } });

  const origId = 'ORIGINAL-OWN-111';
  cacheMessage(SESSION, makeMsg(origId, 'bot message', { fromMe: true }));
  await handleDeletedKey(socket, SESSION, TG, { remoteJid: GROUP, id: origId });

  assert.equal(sendLog.length, 0);
});

test('unknown / uncached ids are ignored safely', async () => {
  const sendLog: Array<{ jid: string; content: Record<string, unknown> }> = [];
  const socket = makeSocket(sendLog);
  setChatEngineConfig(TG, SESSION, GROUP, { antiDelete: { mode: 'on' } });

  await handleDeletedKey(socket, SESSION, TG, { remoteJid: GROUP, id: 'NEVER-CACHED' });
  await handleDeletedKey(socket, SESSION, TG, null);

  assert.equal(sendLog.length, 0);
});

test('recover-once: a second revoke of the same id sends nothing', async () => {
  const sendLog: Array<{ jid: string; content: Record<string, unknown> }> = [];
  const socket = makeSocket(sendLog);
  setChatEngineConfig(TG, SESSION, GROUP, { antiDelete: { mode: 'on' } });

  const origId = 'ORIGINAL-ONCE-222';
  cacheMessage(SESSION, makeMsg(origId, 'recovered once'));
  await handleDeletedKey(socket, SESSION, TG, { remoteJid: GROUP, id: origId });
  await handleDeletedKey(socket, SESSION, TG, { remoteJid: GROUP, id: origId });

  assert.equal(sendLog.length, 1);
});
