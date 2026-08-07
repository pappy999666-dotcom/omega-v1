import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-anti-admin-'));
process.env.WORKSPACE_ROOT = tmpRoot;

const { initWorkspace } = await import('../src/services/workspace.js');
const { saveGroupAntiConfig } = await import('../src/whatsapp/anti-system/config.js');
const { runAntiChecks } = await import('../src/whatsapp/anti-system/index.js');

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('admin link messages bypass AntiLink while normal members remain eligible', async () => {
  const telegramId = 'tg-admin-bypass';
  const sessionId = 'session-admin-bypass';
  const groupJid = '120363000000000000@g.us';
  const adminLid = '987654321@lid';
  const adminPhone = '2348012345678@s.whatsapp.net';
  const memberPhone = '2348098765432@s.whatsapp.net';

  initWorkspace(telegramId);
  saveGroupAntiConfig(telegramId, sessionId, {
    groupJid,
    antilink: {
      enabled: true,
      action: 'delete',
      warnThreshold: 3,
      permitList: [],
    },
  });

  let deletes = 0;
  const socket: any = {
    user: { id: '2348000000000@s.whatsapp.net' },
    groupMetadata: async () => ({
      subject: 'Admin bypass test',
      participants: [
        { id: adminLid, admin: 'admin', phoneNumber: '2348012345678' },
        { id: memberPhone, admin: null, phoneNumber: '2348098765432' },
        { id: '2348000000000@s.whatsapp.net', admin: 'admin', phoneNumber: '2348000000000' },
      ],
    }),
    sendMessage: async (_jid: string, content: any) => {
      if (content?.delete) deletes++;
      return { key: { id: 'mock' } };
    },
  };

  const adminMessage: any = {
    key: {
      id: 'admin-link-message',
      remoteJid: groupJid,
      participant: adminLid,
      fromMe: false,
    },
    message: { conversation: 'https://example.com/admin-link' },
  };

  const memberMessage: any = {
    key: {
      id: 'member-link-message',
      remoteJid: groupJid,
      participant: memberPhone,
      fromMe: false,
    },
    message: { conversation: 'https://example.com/member-link' },
  };

  assert.strictEqual(await runAntiChecks(socket, adminMessage, sessionId, telegramId), false);
  assert.strictEqual(deletes, 0, 'admin message must not be deleted');
  assert.strictEqual(await runAntiChecks(socket, memberMessage, sessionId, telegramId), true);
  assert.strictEqual(deletes, 1, 'ordinary member message remains enforceable');
});
