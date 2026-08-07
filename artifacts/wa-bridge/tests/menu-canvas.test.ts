import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { generateMenuCanvas, resolveMenuMedia } from '../src/services/menu-canvas.js';

const baseOptions: any = {
  prefix: '.',
  menuTarget: 'main',
  status: 'ONLINE',
  userName: 'Operator',
  caption: 'OMEGA menu',
  config: {
    telegramId: 'tg-canvas',
    joinedAt: Date.now(),
    lastActivity: Date.now(),
    prefix: '.',
    nullPrefix: false,
    isBanned: false,
    isOwner: true,
    stickerMacros: {},
    responseMode: 'txt',
    timezone: 'UTC',
  },
  meta: {
    sessionId: 'session-canvas',
    telegramId: 'tg-canvas',
    sessionName: 'Canvas Session',
    phone: '123',
    status: 'ACTIVE',
    pairMethod: 'code',
    errorCount: 0,
    autoJoinDone: true,
  },
};

test('dynamic menu canvas is a 1080x1920 PNG', async () => {
  const buffer = await generateMenuCanvas(baseOptions);
  const metadata = await sharp(buffer).metadata();
  assert.equal(metadata.width, 1080);
  assert.equal(metadata.height, 1920);
  assert.equal(metadata.format, 'png');
});

test('configured user menu media takes precedence over generated canvas', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-menu-canvas-'));
  try {
    const custom = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: { r: 255, g: 0, b: 255 },
      },
    }).png().toBuffer();
    const filePath = path.join(directory, 'custom-menu.png');
    fs.writeFileSync(filePath, custom);

    const media = await resolveMenuMedia({
      ...baseOptions,
      meta: {
        ...baseOptions.meta,
        menuMedia: { type: 'image', filePath, mimeType: 'image/png' },
      },
    });

    assert.equal(media.type, 'image');
    assert.equal(media.mimetype, 'image/png');
    assert.deepEqual(media.buffer, custom);
    assert.equal((await sharp(media.buffer).metadata()).width, 32);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('missing configured media safely falls back to the live canvas', async () => {
  const media = await resolveMenuMedia({
    ...baseOptions,
    meta: {
      ...baseOptions.meta,
      menuMedia: {
        type: 'image',
        filePath: path.join(os.tmpdir(), 'omega-menu-media-does-not-exist.png'),
        mimeType: 'image/png',
      },
    },
  });
  const metadata = await sharp(media.buffer).metadata();
  assert.equal(media.type, 'image');
  assert.equal(media.mimetype, 'image/png');
  assert.equal(metadata.width, 1080);
  assert.equal(metadata.height, 1920);
});
