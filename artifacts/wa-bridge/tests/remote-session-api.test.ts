import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bearerToken,
  getRemoteApiConfig,
  isRemoteApiAuthorized,
  isSessionAllowlisted,
  normalizeRemoteSessionStatus,
  normalizeRemoteText,
  secureTokenEqual,
  validRemoteJid,
} from '../src/web/remote-session-api.js';

test('remote API config is environment-driven and deduplicates its allowlist', () => {
  assert.deepEqual(
    getRemoteApiConfig({
      OMEGA_WAIQ_API_KEY: 'secret',
      OMEGA_WAIQ_SESSION_ALLOWLIST: 'omega-a, omega-b omega-a',
    }),
    { apiKey: 'secret', allowedSessionIds: ['omega-a', 'omega-b'] },
  );
});

test('remote API authentication fails closed and compares tokens safely', () => {
  const config = { apiKey: 'secret', allowedSessionIds: ['omega-a'] };
  assert.equal(bearerToken('Bearer secret'), 'secret');
  assert.equal(isRemoteApiAuthorized('Bearer secret', config), true);
  assert.equal(isRemoteApiAuthorized('Bearer wrong', config), false);
  assert.equal(isRemoteApiAuthorized(undefined, config), false);
  assert.equal(secureTokenEqual('', 'secret'), false);
});

test('only explicitly allowlisted sessions are remotely usable', () => {
  const config = { apiKey: 'secret', allowedSessionIds: ['omega-a'] };
  assert.equal(isSessionAllowlisted('omega-a', config), true);
  assert.equal(isSessionAllowlisted('omega-b', config), false);
  assert.equal(isSessionAllowlisted('omega-a', { ...config, allowedSessionIds: [] }), false);
});

test('remote status and payload validation are conservative', () => {
  assert.equal(normalizeRemoteSessionStatus('ACTIVE'), 'ACTIVE');
  assert.equal(normalizeRemoteSessionStatus('made-up'), 'UNAVAILABLE');
  assert.equal(normalizeRemoteText('hello'), 'hello');
  assert.equal(normalizeRemoteText(''), null);
  assert.equal(normalizeRemoteText(42), null);
  assert.equal(validRemoteJid('2348012345678@s.whatsapp.net'), true);
  assert.equal(validRemoteJid('123@g.us'), true);
  assert.equal(validRemoteJid('https://example.com'), false);
  assert.equal(validRemoteJid('123@lid'), false);
});
