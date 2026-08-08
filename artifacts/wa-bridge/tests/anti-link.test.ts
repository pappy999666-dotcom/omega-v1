import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAllText,
  extractUrls,
  messageContainsLink,
  messageLinks,
  textContainsLink,
} from '../src/whatsapp/anti-system/modules/anti-link.js';

const GROUP = '120363000000000000@g.us';
const MEMBER = '2348098765432@s.whatsapp.net';

function message(content: Record<string, unknown>, remoteJid = GROUP): any {
  return {
    key: { remoteJid, participant: MEMBER, fromMe: false, id: 'anti-link-test' },
    message: content,
  };
}

test('detects generic URLs without a hardcoded domain list', () => {
  const samples = [
    'https://tinydash.pro/25gb',
    'https://example.com',
    'https://example.com/test',
    'https://example.com/path/to/page',
    'https://example.com/?id=123',
    'https://example.com#section',
    'http://example.com',
    'www.example.com',
    'https://sub.example.com/path',
    'https://example.com:8080/test',
    'https://short.example/path',
    'HTTPS://EXAMPLE.COM/UPPER',
  ];

  for (const sample of samples) {
    assert.equal(textContainsLink(sample), true, sample);
    assert.equal(extractUrls(sample).length, 1, sample);
  }
});

test('detects links embedded in prose and finds every link', () => {
  const text = 'Check this https://tinydash.pro/25gb and www.example.com/test, then http://another.example/path?x=1#top.';
  assert.deepEqual(extractUrls(text), [
    'https://tinydash.pro/25gb',
    'www.example.com/test',
    'http://another.example/path?x=1#top',
  ]);
  assert.deepEqual(messageLinks(message({ conversation: text })), [
    'https://tinydash.pro/25gb',
    'www.example.com/test',
    'http://another.example/path?x=1#top',
  ]);
});

test('does not include sentence punctuation or unmatched closing delimiters', () => {
  assert.deepEqual(extractUrls('Visit https://example.com/test.'), ['https://example.com/test']);
  assert.deepEqual(extractUrls('(https://example.com/path), https://example.org/a?x=1!'), [
    'https://example.com/path',
    'https://example.org/a?x=1',
  ]);
  assert.deepEqual(extractUrls('https://example.com/a_(b)'), ['https://example.com/a_(b)']);
});

test('supports captions, extended text, and nested WhatsApp wrappers', () => {
  const cases: Record<string, unknown>[] = [
    { extendedTextMessage: { text: 'Read https://tinydash.pro/25gb' } },
    { imageMessage: { caption: 'Image: https://example.com/image' } },
    { videoMessage: { caption: 'Video: https://example.com/video' } },
    { documentMessage: { caption: 'Document: https://example.com/doc' } },
    { ephemeralMessage: { message: { conversation: 'https://example.com/ephemeral' } } },
    { viewOnceMessageV2: { message: { imageMessage: { caption: 'https://example.com/view-once' } } } },
    { documentWithCaptionMessage: { message: { documentMessage: { caption: 'https://example.com/document' } } } },
    { templateMessage: { hydratedTemplate: { hydratedContentText: 'https://example.com/template' } } },
  ];

  for (const content of cases) assert.equal(messageContainsLink(message(content)), true, JSON.stringify(content));
});

test('detects links in quoted messages without scanning media CDN metadata', () => {
  const quoted = message({
    extendedTextMessage: {
      text: 'reply text',
      contextInfo: { quotedMessage: { conversation: 'quoted https://example.com/quoted' } },
    },
  });
  assert.equal(messageContainsLink(quoted), true);
  assert.deepEqual(extractAllText(quoted), ['reply text', 'quoted https://example.com/quoted']);

  const mediaWithoutCaption = message({
    imageMessage: { url: 'https://mmg.whatsapp.net/download/internal-media.jpg' },
    videoMessage: { url: 'https://cdn.example.com/video.mp4' },
  });
  assert.equal(messageContainsLink(mediaWithoutCaption), false);
});

test('deduplicates identical links while preserving first spelling and order', () => {
  assert.deepEqual(extractUrls('https://example.com https://EXAMPLE.COM https://other.example/path https://example.com'), [
    'https://example.com',
    'https://other.example/path',
  ]);
});

test('only AntiLink enforcement is group-scoped', () => {
  assert.equal(messageContainsLink(message({ conversation: 'https://example.com' }, '2348000000000@s.whatsapp.net')), false);
  assert.equal(messageContainsLink(message({ conversation: 'https://example.com' })), true);
});

test('rejects malformed candidates without rejecting valid links nearby', () => {
  assert.equal(textContainsLink('not a link example'), false);
  assert.equal(textContainsLink('https://example.com/ok and https://bad..example/path'), true);
  assert.deepEqual(extractUrls('https://example.com/ok and https://bad..example/path'), ['https://example.com/ok']);
  assert.deepEqual(extractUrls('https://bad.example.com/ok'), ['https://bad.example.com/ok']);
  assert.deepEqual(extractUrls('https://bad..example.com/ok'), []);
  assert.deepEqual(extractUrls('https://-bad.example.com/ok'), []);
});

test('detects interactive and group-status user-visible text', () => {
  assert.equal(messageContainsLink(message({
    interactiveMessage: {
      header: { title: 'Header' },
      body: { text: 'Open https://example.com/interactive' },
      footer: { text: 'Footer' },
    },
  })), true);
  assert.equal(messageContainsLink(message({
    groupStatusMentionMessage: {
      message: { conversation: 'Status link https://example.com/status' },
    },
  })), true);
});

test('trims common unicode sentence punctuation', () => {
  assert.deepEqual(extractUrls('https://example.com/path。 https://example.org/x！ https://example.net/y？'), [
    'https://example.com/path',
    'https://example.org/x',
    'https://example.net/y',
  ]);
});
