// ============================================================
// Tutorial Registry — Tests
//
// Covers: registry-driven command validation (unknown commands
// rejected, valid commands from MENU_CATALOG accepted), save /
// get / list / remove lifecycle, media file persistence and
// atomic replacement.
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate the registry into a temp workspace BEFORE importing the service.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-tutorials-test-'));
process.env.WORKSPACE_ROOT = tmpRoot;

const {
  validTutorialCommands,
  isValidTutorialCommand,
  getTutorial,
  listTutorials,
  saveTutorialMedia,
  removeTutorial,
} = await import('../src/services/tutorials.js');

test('command validation reads the central registry (no hardcoding)', () => {
  const commands = validTutorialCommands();
  assert.ok(commands.length > 50, 'registry exposes the full command list');
  // Commands that definitely live in the central registry.
  for (const cmd of ['wyr', 'quiz', 'help', 'ping', 'kick']) {
    assert.ok(commands.includes(cmd), `${cmd} must be a valid tutorial command`);
    assert.equal(isValidTutorialCommand(cmd), true);
  }
  // Unknown / malformed commands are rejected.
  assert.equal(isValidTutorialCommand('notacommandxyz'), false);
  assert.equal(isValidTutorialCommand(''), false);
  assert.equal(isValidTutorialCommand('.kick'), false, 'raw dotted input is not registry-listed (the Telegram flow strips dots first)');
});

test('save → get → list → remove lifecycle with media files', () => {
  const img = Buffer.from('fake-image-bytes');
  const rec = saveTutorialMedia('wyr', 'image', img, 'image/jpeg');
  assert.ok(rec, 'record returned');
  assert.equal(rec.command, 'wyr');
  assert.equal(rec.type, 'image');
  assert.ok(fs.existsSync(rec.filePath), 'media file persisted');
  assert.equal(fs.readFileSync(rec.filePath).toString(), 'fake-image-bytes');

  const fetched = getTutorial('wyr');
  assert.ok(fetched);
  assert.equal(fetched.command, 'wyr');
  assert.equal(fetched.type, 'image');

  assert.equal(listTutorials().length, 1);
  assert.equal(listTutorials()[0]!.command, 'wyr');

  // Removing cleans the media file and the index entry.
  const removed = removeTutorial('wyr');
  assert.equal(removed, true);
  assert.ok(!fs.existsSync(rec.filePath), 'media file removed');
  assert.equal(getTutorial('wyr'), null);
  assert.equal(listTutorials().length, 0);
  assert.equal(removeTutorial('wyr'), false, 'second remove is a no-op');
});

test('tutorials retain independent image and video assets', async () => {
  const first = saveTutorialMedia('quiz', 'image', Buffer.from('first-image'), 'image/png')!;
  assert.ok(fs.existsSync(first.filePath));

  const second = saveTutorialMedia('quiz', 'video', Buffer.from('second-video'), 'video/mp4')!;
  assert.equal(second.type, 'video');
  assert.equal(getTutorial('quiz')!.type, 'video');
  assert.equal(listTutorials().length, 1, 'no duplicate index entries');
  assert.ok(fs.existsSync(first.filePath), 'helper image remains when video is added');
  assert.ok(fs.existsSync(second.filePath), 'helper video persisted');
  assert.equal(fs.readFileSync(second.filePath).toString(), 'second-video');

  const replacement = saveTutorialMedia('quiz', 'image', Buffer.from('replacement-image'), 'image/webp')!;
  assert.ok(!fs.existsSync(first.filePath), 'replaced image file cleaned up');
  assert.ok(fs.existsSync(second.filePath), 'video remains when image is replaced');
  assert.equal(fs.readFileSync(replacement.filePath).toString(), 'replacement-image');

  removeTutorial('quiz');
  assert.ok(!fs.existsSync(second.filePath), 'video removed with tutorial');
  assert.ok(!fs.existsSync(replacement.filePath), 'image removed with tutorial');
});

test('unknown commands never create tutorials', () => {
  const rec = saveTutorialMedia('definitely-not-a-command', 'image', Buffer.from('x'), 'image/jpeg');
  assert.equal(rec, null);
  assert.equal(getTutorial('definitely-not-a-command'), null);
  assert.equal(listTutorials().length, 0);
});

// Cleanup temp workspace.
test.after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});
