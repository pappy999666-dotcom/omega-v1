import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateSessionProfilePicture } from '../src/whatsapp/utils/profile-controls.js';

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
