import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageIsGroupStatusMention } from '../src/whatsapp/anti-system/modules/anti-gm.js';

const GROUP = '1234567890@g.us';

function makeMsg(overrides: Record<string, unknown> = {}): any {
  return {
    key: { remoteJid: GROUP, fromMe: false, id: 'msg-1', participant: '15550001111@s.whatsapp.net' },
    message: {},
    ...overrides,
  };
}

// ── True positive: native Status @Group payload with real inner content ──
test('detects genuine groupStatusMentionMessage with real inner content', () => {
  const msg = makeMsg({
    message: {
      groupStatusMentionMessage: {
        message: {
          extendedTextMessage: { text: 'Check out this group status!' },
        },
        contextInfo: { mentionedJid: [GROUP] },
      },
    },
  });
  assert.equal(messageIsGroupStatusMention(msg, GROUP), true);
});

test('detects status mention with sticker inner content', () => {
  const msg = makeMsg({
    message: {
      groupStatusMentionMessage: {
        message: { stickerMessage: { url: 'https://cdn.example.com/s.webp' } },
      },
    },
  });
  assert.equal(messageIsGroupStatusMention(msg, GROUP), true);
});

// ── The old false-positive bug: empty protobuf objects must NOT trigger ──
test('IGNORES empty groupStatusMentionMessage wrapper (old false-positive bug)', () => {
  // protobufjs materializes absent fields as {} — this is the exact payload
  // shape that made the old detector delete EVERY message.
  const msg = makeMsg({ message: { groupStatusMentionMessage: {} } });
  assert.equal(messageIsGroupStatusMention(msg, GROUP), false);
});

test('IGNORES groupStatusMentionMessage whose inner is only protocolMessage', () => {
  const msg = makeMsg({
    message: {
      groupStatusMentionMessage: {
        message: { protocolMessage: { type: 0 } },
      },
    },
  });
  assert.equal(messageIsGroupStatusMention(msg, GROUP), false);
});

// ── Everything else must be ignored (zero false positives) ──
test('IGNORES normal text', () => {
  const msg = makeMsg({ message: { conversation: 'hello everyone' } });
  assert.equal(messageIsGroupStatusMention(msg, GROUP), false);
});

test('IGNORES images', () => {
  const msg = makeMsg({ message: { imageMessage: { url: 'https://x/img.jpg', caption: 'pic' } } });
  assert.equal(messageIsGroupStatusMention(msg, GROUP), false);
});

test('IGNORES stickers', () => {
  const msg = makeMsg({ message: { stickerMessage: { url: 'https://x/s.webp' } } });
  assert.equal(messageIsGroupStatusMention(msg, GROUP), false);
});

test('IGNORES videos', () => {
  const msg = makeMsg({ message: { videoMessage: { url: 'https://x/v.mp4' } } });
  assert.equal(messageIsGroupStatusMention(msg, GROUP), false);
});

test('IGNORES voice notes', () => {
  const msg = makeMsg({ message: { audioMessage: { url: 'https://x/a.opus', ptt: true } } });
  assert.equal(messageIsGroupStatusMention(msg, GROUP), false);
});

test('IGNORES polls', () => {
  const msg = makeMsg({ message: { pollCreationMessage: { name: 'vote' } } });
  assert.equal(messageIsGroupStatusMention(msg, GROUP), false);
});

test('IGNORES forwarded messages', () => {
  const msg = makeMsg({
    message: {
      extendedTextMessage: { text: 'fwd', contextInfo: { forwardingScore: 5 } },
    },
  });
  assert.equal(messageIsGroupStatusMention(msg, GROUP), false);
});

test('IGNORES quoted messages', () => {
  const msg = makeMsg({
    message: {
      extendedTextMessage: {
        text: 'reply',
        contextInfo: { quotedMessage: { conversation: 'original' } },
      },
    },
  });
  assert.equal(messageIsGroupStatusMention(msg, GROUP), false);
});

test('IGNORES group-mention metadata (contextInfo.groupMentions)', () => {
  const msg = makeMsg({
    message: {
      extendedTextMessage: {
        text: '@group',
        contextInfo: { groupMentions: [{ groupJid: GROUP, subject: 'x' }] },
      },
    },
  });
  assert.equal(messageIsGroupStatusMention(msg, GROUP), false);
});

test('IGNORES status mention sources / replies', () => {
  const msg = makeMsg({
    message: {
      extendedTextMessage: {
        text: 'status reply',
        contextInfo: { mentionedJid: [GROUP] },
      },
    },
  });
  assert.equal(messageIsGroupStatusMention(msg, GROUP), false);
});

// ── Scoping rules ──
test('IGNORES messages from other chats', () => {
  const msg = makeMsg({
    key: { remoteJid: '999@g.us', fromMe: false, id: 'm2' },
    message: { groupStatusMentionMessage: { message: { conversation: 'x' } } },
  });
  assert.equal(messageIsGroupStatusMention(msg, GROUP), false);
});

test('IGNORES non-group chats', () => {
  const msg = makeMsg({
    key: { remoteJid: '15550001111@s.whatsapp.net', fromMe: false, id: 'm3' },
    message: { groupStatusMentionMessage: { message: { conversation: 'x' } } },
  });
  assert.equal(messageIsGroupStatusMention(msg, GROUP), false);
});

test('IGNORES bot own traffic (fromMe)', () => {
  const msg = makeMsg({
    key: { remoteJid: GROUP, fromMe: true, id: 'm4' },
    message: { groupStatusMentionMessage: { message: { conversation: 'x' } } },
  });
  assert.equal(messageIsGroupStatusMention(msg, GROUP), false);
});

// ── Edge cases ──
test('handles null message / null key gracefully', () => {
  assert.equal(messageIsGroupStatusMention({} as any, GROUP), false);
  assert.equal(messageIsGroupStatusMention({ key: null } as any, GROUP), false);
});

test('detects groupStatusMessage inner wrapped in ephemeral', () => {
  const msg = makeMsg({
    message: {
      groupStatusMentionMessage: {
        message: {
          ephemeralMessage: { message: { conversation: 'wrapped status' } },
        },
      },
    },
  });
  assert.equal(messageIsGroupStatusMention(msg, GROUP), true);
});
