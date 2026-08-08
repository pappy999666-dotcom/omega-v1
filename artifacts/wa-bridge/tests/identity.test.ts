// Targeted unit tests for src/whatsapp/utils/identity.ts
// Run: node --import tsx --test tests/identity.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripDeviceSuffix,
  normalizeJid,
  numericId,
  isLidJid,
  isPhoneJid,
  normalizePhone,
  getContextInfoAny,
  quotedMessageOf,
  extractMessageTextAny,
  normalizeParticipantEntries,
  normalizeParticipantUpdateJids,
  authorFromUpdate,
  buildQuotedKey,
  resolveIdentity,
} from '../src/whatsapp/utils/identity.js';
import type { WebMessageInfo, IMessage, MessageContextInfo } from '../src/whatsapp/baileys-types.js';

// ── JID shaping ────────────────────────────────────────────

test('stripDeviceSuffix removes :device from user part', () => {
  assert.equal(stripDeviceSuffix('123:45@s.whatsapp.net'), '123@s.whatsapp.net');
  assert.equal(stripDeviceSuffix('123@s.whatsapp.net'), '123@s.whatsapp.net');
  assert.equal(stripDeviceSuffix('nouserpart'), 'nouserpart');
});

test('normalizeJid strips device suffix and handles falsy input', () => {
  assert.equal(normalizeJid('123:45@s.whatsapp.net'), '123@s.whatsapp.net');
  assert.equal(normalizeJid('123:45@lid'), '123@lid');
  assert.equal(normalizeJid(null), '');
  assert.equal(normalizeJid(undefined), '');
  assert.equal(normalizeJid(''), '');
});

test('numericId returns the raw numeric user part', () => {
  assert.equal(numericId('123:45@s.whatsapp.net'), '123');
  assert.equal(numericId('9876543210@lid'), '9876543210');
  assert.equal(numericId(null), '');
});

test('isLidJid / isPhoneJid classify JID domains', () => {
  assert.equal(isLidJid('123@lid'), true);
  assert.equal(isLidJid('123@s.whatsapp.net'), false);
  assert.equal(isPhoneJid('123@s.whatsapp.net'), true);
  assert.equal(isPhoneJid('123@lid'), false);
});

test('normalizePhone extracts digits from any number/JID form', () => {
  assert.equal(normalizePhone('+1 (234) 567-8900'), '12345678900');
  assert.equal(normalizePhone('123:45@s.whatsapp.net'), '123');
  assert.equal(normalizePhone('9876543210@lid'), '9876543210');
  assert.equal(normalizePhone(null), '');
});

// ── Context extraction for all message types ───────────────

const ci = (over: Partial<MessageContextInfo> = {}): MessageContextInfo => ({ stanzaId: 's1', ...over });

test('getContextInfoAny finds contextInfo inside wrapped containers', () => {
  const ctx = ci({ participant: 'p@lid' });
  const msg: IMessage = { ephemeralMessage: { message: { extendedTextMessage: { text: 'x', contextInfo: ctx } } } };
  assert.equal(getContextInfoAny(msg), ctx);
  assert.equal(getContextInfoAny(msg)?.participant, 'p@lid');
});

test('getContextInfoAny digs through viewOnceMessage and groupStatusMessage', () => {
  const ctx = ci();
  const viewOnce: IMessage = { viewOnceMessageV2: { message: { imageMessage: { caption: 'c', contextInfo: ctx } } } };
  assert.equal(getContextInfoAny(viewOnce), ctx);

  const gs: IMessage = { groupStatusMessageV2: { message: { extendedTextMessage: { text: 't', contextInfo: ctx } } } };
  assert.equal(getContextInfoAny(gs), ctx);
});

test('getContextInfoAny returns null for messages without context', () => {
  assert.equal(getContextInfoAny({ conversation: 'plain' }), null);
  assert.equal(getContextInfoAny(null), null);
});

test('quotedMessageOf returns the quoted payload', () => {
  const quoted: IMessage = { conversation: 'the quote' };
  const msg: IMessage = { extendedTextMessage: { text: 'reply', contextInfo: ci({ quotedMessage: quoted }) } };
  assert.equal(quotedMessageOf(msg), quoted);
  assert.equal(quotedMessageOf({ conversation: 'x' }), null);
});

test('quotedMessageOf finds quotes inside wrapped media messages', () => {
  const quoted: IMessage = { extendedTextMessage: { text: 'quoted after restart' } };
  const msg: IMessage = {
    ephemeralMessage: {
      message: {
        imageMessage: {
          caption: '.tag',
          contextInfo: ci({ quotedMessage: quoted }),
        },
      },
    },
  };
  const found = quotedMessageOf(msg);
  assert.equal(found, quoted);
  assert.equal(extractMessageTextAny(found), 'quoted after restart');
});

test('extractMessageTextAny handles every message type', () => {
  assert.equal(extractMessageTextAny({ conversation: 'hello' }), 'hello');
  assert.equal(extractMessageTextAny({ extendedTextMessage: { text: 'etext' } }), 'etext');
  assert.equal(extractMessageTextAny({ imageMessage: { caption: 'imgcap' } }), 'imgcap');
  assert.equal(extractMessageTextAny({ videoMessage: { caption: 'vidcap' } }), 'vidcap');
  assert.equal(extractMessageTextAny({ documentMessage: { caption: 'doccap' } }), 'doccap');
  assert.equal(extractMessageTextAny({ buttonsMessage: { contentText: 'btn' } }), 'btn');
  assert.equal(extractMessageTextAny({ listResponseMessage: { singleSelectReply: { selectedRowId: 'row7' } } }), 'row7');
  assert.equal(extractMessageTextAny({ buttonsResponseMessage: { selectedButtonId: 'id9' } }), 'id9');
  assert.equal(extractMessageTextAny({ pollCreationMessage: { name: 'Poll?' } }), 'Poll?');
  assert.equal(
    extractMessageTextAny({ ephemeralMessage: { message: { extendedTextMessage: { text: 'eph' } } } }),
    'eph'
  );
  assert.equal(
    extractMessageTextAny({ viewOnceMessage: { message: { imageMessage: { caption: 'vo' } } } }),
    'vo'
  );
  assert.equal(
    extractMessageTextAny({ viewOnceMessageV2Extension: { message: { extendedTextMessage: { text: '.tag' } } } }),
    '.tag'
  );
  assert.equal(
    extractMessageTextAny({ groupStatusMessage: { message: { extendedTextMessage: { text: 'gst' } } } }),
    'gst'
  );
  assert.equal(extractMessageTextAny({ audioMessage: {} }), '');
});

// ── group-participants.update payload normalization ────────

test('normalizeParticipantEntries passes string JIDs through', () => {
  assert.deepEqual(normalizeParticipantEntries(['123@s.whatsapp.net', '456:7@lid']), [
    '123@s.whatsapp.net',
    '456@lid',
  ]);
});

test('normalizeParticipantEntries prefers phone JIDs over LIDs for object entries', () => {
  const out = normalizeParticipantEntries([
    { id: '999@s.whatsapp.net', phoneNumber: '999' },
    { id: 'abc@lid', lid: 'abc@lid', phoneNumber: '9876543210@s.whatsapp.net' },
    { jid: 'xyz@lid' },
  ]);
  assert.deepEqual(out, ['999@s.whatsapp.net', '9876543210@s.whatsapp.net', 'xyz@lid']);
});

test('normalizeParticipantEntries skips empty entries', () => {
  assert.deepEqual(normalizeParticipantEntries([{}, null, undefined, '']), []);
});

test('authorFromUpdate prefers authorPn then author then actor', () => {
  assert.equal(authorFromUpdate({ authorPn: '1@lid', author: '2@s.whatsapp.net' }), '1@lid');
  assert.equal(authorFromUpdate({ author: '2@s.whatsapp.net' }), '2@s.whatsapp.net');
  assert.equal(authorFromUpdate({ actor: '3@s.whatsapp.net' }), '3@s.whatsapp.net');
  assert.equal(authorFromUpdate({}), undefined);
});

// ── group-participants.update payload normalization (event-handlers boundary) ──

test('normalizeParticipantUpdateJids prefers real phone JIDs from LID entries', () => {
  const out = normalizeParticipantUpdateJids([
    '15550001111@s.whatsapp.net',
    { id: '150268759003140@lid', phoneNumber: '15551234567' },
    { id: '15029876543210@lid', pn: '15552345678' },
    { id: '15027890123456@lid' },
    { id: '15559876543@lid', phoneNumber: '15559876543@s.whatsapp.net' },
  ]);
  assert.deepEqual(out, [
    '15550001111@s.whatsapp.net',
    '15551234567@s.whatsapp.net',
    '15552345678@s.whatsapp.net',
    '15027890123456@lid',
    '15559876543@s.whatsapp.net',
  ]);
});

test('normalizeParticipantUpdateJids skips empty entries and dedupes', () => {
  const out = normalizeParticipantUpdateJids([
    {}, null, undefined, '',
    { id: '15550001111@s.whatsapp.net', phoneNumber: '15550001111' },
    '15550001111@s.whatsapp.net',
  ]);
  assert.deepEqual(out, ['15550001111@s.whatsapp.net']);
});

// ── resolveIdentity: LID → real phone via the participant entry's own fields ──

test('resolveIdentity resolves a LID via its participant phoneNumber field', async () => {
  const out = await resolveIdentity({} as any, '150268759003140@lid', [
    { id: '150268759003140@lid', phoneNumber: '15551234567' },
    { id: '9999999999@s.whatsapp.net' },
  ]);
  assert.equal(out.jid, '15551234567@s.whatsapp.net');
  assert.equal(out.number, '15551234567');
  assert.equal(out.isLid, true);
});

test('resolveIdentity never fabricates a phone from LID digits', async () => {
  const out = await resolveIdentity({} as any, '150268759003140@lid', [
    { id: '15551234567@s.whatsapp.net', phoneNumber: '15551234567' },
  ]);
  // No participant entry carries the LID itself → unresolvable → fail closed.
  assert.equal(out.jid, '');
  assert.equal(out.number, '');
});

// ── quoted key builder ─────────────────────────────────────

function makeMsg(key: Record<string, unknown>, message: IMessage): WebMessageInfo {
  return { key: key as WebMessageInfo['key'], message };
}

test('buildQuotedKey uses stanzaId + resolved sender', () => {
  const msg = makeMsg({ id: 'outer-id', remoteJid: 'g@g.us' }, {
    extendedTextMessage: {
      text: 'r',
      contextInfo: ci({ stanzaId: 'quoted-id', participant: 'other@s.whatsapp.net', remoteJid: 'g@g.us' }),
    },
  });
  const key = buildQuotedKey(msg, 'g@g.us', 'me@s.whatsapp.net');
  assert.equal(key.id, 'quoted-id');
  assert.equal(key.remoteJid, 'g@g.us');
  assert.equal(key.participant, 'me@s.whatsapp.net'); // resolved sender wins
  assert.equal(key.fromMe, false);
});
