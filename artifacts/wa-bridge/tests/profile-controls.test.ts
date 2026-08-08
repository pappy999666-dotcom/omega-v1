import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateGroupProfilePicture, updateSessionProfilePicture } from '../src/whatsapp/utils/profile-controls.js';

test('setpfp sends original image bytes with HD enabled', async () => {
  const image = Buffer.from([0, 1, 2, 3, 4]);
  let call: { jid: string; content: Buffer; opts?: { hd?: boolean } } | undefined;
  const socket: any = {
    user: { id: '2348012345678@s.whatsapp.net' },
    updateProfilePicture: async (jid: string, content: Buffer, opts?: { hd?: boolean }) => {
      call = { jid, content, opts };
    },
  };

  const jid = await updateSessionProfilePicture(socket, socket.user.id, image);
  assert.equal(jid, '2348012345678@s.whatsapp.net');
  assert.equal(call?.jid, jid);
  assert.deepEqual(call?.content, image);
  assert.deepEqual(call?.opts, { hd: true });
});

test('setgpp updates an existing group in place with HD and original bytes', async () => {
  const image = Buffer.from([9, 8, 7]);
  let call: { jid: string; content: Buffer; opts?: { hd?: boolean } } | undefined;
  const socket: any = {
    updateProfilePicture: async (jid: string, content: Buffer, opts?: { hd?: boolean }) => {
      call = { jid, content, opts };
    },
  };

  const jid = await updateGroupProfilePicture(socket, '120363123456789@g.us', image);
  assert.equal(jid, '120363123456789@g.us');
  assert.equal(call?.jid, jid);
  assert.deepEqual(call?.content, image);
  assert.deepEqual(call?.opts, { hd: true });
});

test('setgpp refuses a non-group target without touching the socket', async () => {
  let called = false;
  const socket: any = {
    updateProfilePicture: async () => { called = true; },
  };
  await assert.rejects(
    updateGroupProfilePicture(socket, '2348012345678@s.whatsapp.net', Buffer.from([1])),
    /existing WhatsApp group/i
  );
  assert.equal(called, false);
});

test('setpfp refuses an unresolved LID instead of fabricating a phone JID', async () => {
  let called = false;
  const socket: any = {
    user: { id: '150268759003140@lid' },
    updateProfilePicture: async () => { called = true; },
  };

  await assert.rejects(
    updateSessionProfilePicture(socket, socket.user.id, Buffer.from([1])),
    /phone identity is unavailable/i
  );
  assert.equal(called, false);
});
