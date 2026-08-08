import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePairingPhone } from '../src/whatsapp/socket-manager.js';
import { findCountryCallingCode, formatCountryCodeGuide } from '../src/whatsapp/utils/country-codes.js';

test('pairing phone normalization accepts spaced international numbers', () => {
  assert.equal(normalizePairingPhone('+234 816 416 7112'), '2348164167112');
  assert.equal(normalizePairingPhone('+1 (415) 555-2671'), '14155552671');
});

test('pairing phone normalization rejects letters and unsupported symbols', () => {
  assert.throws(() => normalizePairingPhone('+234 abc 8164167112'), /normal separators only/u);
  assert.throws(() => normalizePairingPhone('+234/8164167112'), /normal separators only/u);
});

test('pairing phone normalization rejects invalid zero prefixes with actionable guidance', () => {
  assert.throws(
    () => normalizePairingPhone('+0 816 416 7112'),
    /\+0 does not exist.*\.pair codes/u
  );
  assert.throws(
    () => normalizePairingPhone('08164167112'),
    /local numbers starting with 0 need their country code first/u
  );
});

test('WhatsApp pairing can reject unknown country-code prefixes when requested', () => {
  assert.throws(
    () => normalizePairingPhone('+999 1234567', { requireAssignedCountryCode: true }),
    /Unknown country code \+999/u
  );
});

test('shared Telegram/web normalization keeps valid E.164 service prefixes compatible', () => {
  assert.equal(normalizePairingPhone('+800 1234567'), '8001234567');
});

test('country-code lookup uses assigned international prefixes', () => {
  assert.equal(findCountryCallingCode('2348164167112')?.countries, 'Nigeria');
  assert.equal(findCountryCallingCode('14155552671')?.code, '1');
  assert.equal(findCountryCallingCode('09999999999'), null);
});

test('country-code guide explains international format and common examples', () => {
  const guide = formatCountryCodeGuide();
  assert.match(guide, /\+234 Nigeria/u);
  assert.match(guide, /\+1 US, Canada/u);
  assert.match(guide, /Never start with \+0/u);
  assert.match(guide, /Spaces, hyphens and parentheses/u);
});
