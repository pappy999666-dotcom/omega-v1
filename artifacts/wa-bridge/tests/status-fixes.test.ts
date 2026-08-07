import { test } from 'node:test';
import assert from 'node:assert';
import { quotedSourceOf, cmdViewOnce, cmdPStatus } from '../src/whatsapp/personal-engine.js';
import {
  rememberStatusContact,
  getStatusJidList,
  resolveStatusJidList,
} from '../src/whatsapp/utils/status-jids.js';

test('quotedSourceOf builds the ORIGINAL key from contextInfo', () => {
  const msg: any = {
    key: { id: 'cmd-id', remoteJid: '123@g.us', fromMe: true },
    message: {
      extendedTextMessage: {
        text: '.vv',
        contextInfo: {
          stanzaId: 'orig-stanza-42',
          participant: '2348012345678@s.whatsapp.net',
          remoteJid: '123@g.us',
          quotedMessage: {
            viewOnceMessageV2: {
              message: { imageMessage: { url: 'x', mimetype: 'image/jpeg', viewOnce: true } },
            },
          },
        },
      },
    },
  };
  const src = quotedSourceOf(msg)!;
  assert.ok(src, 'should resolve a quoted source');
  assert.strictEqual(src.key.id, 'orig-stanza-42');
  assert.strictEqual(src.key.participant, '2348012345678@s.whatsapp.net');
  assert.strictEqual(src.key.remoteJid, '123@g.us');
  assert.strictEqual(src.key.fromMe, false);
  assert.ok((src.message as any).viewOnceMessageV2, 'quoted message preserved');
});

test('quotedSourceOf returns null without a quote', () => {
  const msg: any = { key: {}, message: { conversation: '.pstatus hello' } };
  assert.strictEqual(quotedSourceOf(msg), null);
});

test('resolveStatusJidList never returns an empty list (self-JID fallback)', () => {
  const socket: any = { user: { id: '2348012345678:11@s.whatsapp.net' } };
  const list = resolveStatusJidList(socket, 'sess-1');
  assert.ok(list.length >= 1, 'never empty');
  assert.ok(list.includes('2348012345678@s.whatsapp.net'), 'self jid included');
  assert.ok(
    list.every((j) => j.endsWith('@s.whatsapp.net') || j.endsWith('@lid')),
    'only valid user JIDs'
  );
});

test('status contact tracking: active status priority, dedupe, no downgrade', () => {
  rememberStatusContact('sess-2', '11111111111@s.whatsapp.net', false);
  rememberStatusContact('sess-2', '22222222222@s.whatsapp.net', true);
  const tracked = getStatusJidList('sess-2');
  assert.ok(tracked.includes('22222222222@s.whatsapp.net'), 'active status contact listed');

  const all = resolveStatusJidList({ user: { id: '999@s.whatsapp.net' } }, 'sess-2');
  assert.strictEqual(new Set(all).size, all.length, 'deduped');

  // contacts.update with status=false must never downgrade an active contact
  rememberStatusContact('sess-2', '22222222222@s.whatsapp.net', false);
  assert.ok(getStatusJidList('sess-2').includes('22222222222@s.whatsapp.net'), 'no downgrade');
});

test('cmdPStatus posts with a non-empty statusJidList option', async () => {
  const sent: any[] = [];
  const socket: any = {
    user: { id: '2348012345678:1@s.whatsapp.net' },
    sendMessage: async (jid: string, content: any, options: any) => {
      sent.push({ jid, content, options });
      return { key: { id: 'status-key-1' } };
    },
  };
  const msg: any = { key: { id: 'x', remoteJid: '2348012345678@s.whatsapp.net' }, message: { conversation: '.pstatus Hello World' } };
  const out = await cmdPStatus(socket, 'tg-1', 'sess-1', msg, 'Hello World', '.');
  assert.ok(!out.includes('Post failed'), out);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].jid, 'status@broadcast');
  assert.ok(
    Array.isArray(sent[0].options.statusJidList) && sent[0].options.statusJidList.length > 0,
    'statusJidList passed to the fork'
  );
});

test('cmdPStatus recovers quoted media via the quoted key (unreachable url → clean error card)', async () => {
  const socket: any = {
    user: { id: '2348012345678:1@s.whatsapp.net' },
    updateMediaMessage: async (m: any) => m,
    sendMessage: async () => ({ key: { id: 'k' } }),
  };
  const msg: any = {
    key: { id: 'cmd', remoteJid: '123@g.us', fromMe: true },
    message: {
      extendedTextMessage: {
        text: '.pstatus',
        contextInfo: {
          stanzaId: 'orig-img-1',
          participant: '2348012345678@s.whatsapp.net',
          remoteJid: '123@g.us',
          quotedMessage: { imageMessage: { url: 'http://127.0.0.1:1/x', mimetype: 'image/jpeg' } },
        },
      },
    },
  };
  const out = await cmdPStatus(socket, 'tg-1', 'sess-1', msg, '', '.');
  // The quoted media WAS detected — so we must NOT get the "Reply to media" fallback.
  assert.ok(!out.includes('Reply to media or send text'), 'quote media was detected: ' + out);
  assert.ok(out.includes('PERSONAL STATUS'), out);
  assert.ok(out.includes('Could not download the replied media'), 'explicit unrecoverable-media error: ' + out);
});

test('cmdViewOnce detects a quote whose view-once WRAPPER was stripped (media flagged viewOnce)', async () => {
  // Some clients deliver the quoted message WITHOUT the viewOnceMessage
  // wrapper but keep the media flagged viewOnce:true — this is the reported
  // "Reply to a View Once image or video" false-negative.
  const socket: any = {
    user: { id: '2348012345678:1@s.whatsapp.net' },
    updateMediaMessage: async (m: any) => m,
    sendMessage: async () => ({ key: { id: 'k' } }),
  };
  const msg: any = {
    key: { id: 'cmd', remoteJid: '123@g.us', fromMe: true },
    message: {
      extendedTextMessage: {
        text: '.vv',
        contextInfo: {
          stanzaId: 'orig-stripped-1',
          participant: '2348012345678@s.whatsapp.net',
          remoteJid: '123@g.us',
          quotedMessage: { imageMessage: { url: 'http://127.0.0.1:1/z', mimetype: 'image/jpeg', viewOnce: true } },
        },
      },
    },
  };
  const out = await cmdViewOnce(socket, 'sess-1', 'tg-1', '123@g.us', msg, false, '.');
  assert.ok(!out.includes('Reply to a View Once image or video'), 'stripped view-once detected: ' + out);
  assert.ok(out.includes('VIEW ONCE'), out);
});

test('cmdViewOnce detects nested view-once wrappers (V2Extension > V2 > content)', async () => {
  const socket: any = {
    user: { id: '2348012345678:1@s.whatsapp.net' },
    updateMediaMessage: async (m: any) => m,
    sendMessage: async () => ({ key: { id: 'k' } }),
  };
  const msg: any = {
    key: { id: 'cmd', remoteJid: '123@g.us', fromMe: true },
    message: {
      extendedTextMessage: {
        text: '.vv',
        contextInfo: {
          stanzaId: 'orig-nested-1',
          participant: '2348012345678@s.whatsapp.net',
          remoteJid: '123@g.us',
          quotedMessage: {
            viewOnceMessageV2Extension: {
              message: {
                viewOnceMessageV2: {
                  message: { videoMessage: { url: 'http://127.0.0.1:1/v', mimetype: 'video/mp4', viewOnce: true } },
                },
              },
            },
          },
        },
      },
    },
  };
  const out = await cmdViewOnce(socket, 'sess-1', 'tg-1', '123@g.us', msg, false, '.');
  assert.ok(!out.includes('Reply to a View Once image or video'), 'nested view-once detected: ' + out);
  assert.ok(out.includes('VIEW ONCE'), out);
});

test('cmdViewOnce reaches the quoted view-once path', async () => {
  const socket: any = {
    user: { id: '2348012345678:1@s.whatsapp.net' },
    updateMediaMessage: async (m: any) => m,
    sendMessage: async () => ({ key: { id: 'k' } }),
  };
  const msg: any = {
    key: { id: 'cmd', remoteJid: '123@g.us', fromMe: true },
    message: {
      extendedTextMessage: {
        text: '.vv',
        contextInfo: {
          stanzaId: 'orig-vo-1',
          participant: '2348012345678@s.whatsapp.net',
          remoteJid: '123@g.us',
          quotedMessage: {
            viewOnceMessage: {
              message: { imageMessage: { url: 'http://127.0.0.1:1/y', mimetype: 'image/jpeg', viewOnce: true } },
            },
          },
        },
      },
    },
  };
  const out = await cmdViewOnce(socket, 'sess-1', 'tg-1', '123@g.us', msg, false, '.');
  // The quoted view-once message was detected (not "Reply to a View Once").
  assert.ok(!out.includes('Reply to a View Once image or video'), 'quoted view-once detected: ' + out);
  assert.ok(out.includes('VIEW ONCE'), out);
});
