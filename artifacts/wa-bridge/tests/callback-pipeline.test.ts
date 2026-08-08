import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-callback-pipeline-'));
process.env.WORKSPACE_ROOT = root;
process.env.TELEGRAM_OWNER_ID = 'owner-telegram';

const { sessionMenuKeyboard, gameApiKeyboard, adminPanelKeyboard } = await import('../src/telegram/ui/keyboards.js');
const { initWorkspace, saveSessionMeta, loadSessionConfig, loadSessionMeta, updateSessionConfig } = await import('../src/services/workspace.js');
const { handleTutorialsMenu } = await import('../src/telegram/handlers/tutorials.js');
const { ownerOnly } = await import('../src/telegram/middlewares/auth.js');

function callbackData(markup: { inline_keyboard: Array<Array<{ callback_data?: string }>> }): string[] {
  return markup.inline_keyboard.flat().map((button) => button.callback_data).filter((value): value is string => Boolean(value));
}

function createSession(telegramId: string, sessionId: string): void {
  initWorkspace(telegramId);
  saveSessionMeta({
    telegramId,
    sessionId,
    label: sessionId,
    phone: '2348000000000',
    status: 'ACTIVE',
    pairMethod: 'qr',
  } as never);
}

test('Game API button uses one canonical per-session callback and exposes the setup flow', () => {
  const menu = callbackData(sessionMenuKeyboard('session-a', 'ACTIVE'));
  assert.ok(menu.includes('session:session-a:gameapi'));
  assert.equal(menu.filter((value) => value === 'session:session-a:gameapi').length, 1);

  const gameApi = callbackData(gameApiKeyboard('session-a', false));
  assert.deepEqual(gameApi, [
    'session:session-a:gameapi',
    'session:session-a:gameapi:setup',
    'session:session-a:gameapi:test',
    'session:session-a:gameapi:tutorial',
    'session:session-a:menu',
  ]);
});

test('Game API configuration remains isolated by WhatsApp session', () => {
  createSession('owner-telegram', 'session-a');
  createSession('owner-telegram', 'session-b');

  updateSessionConfig('owner-telegram', 'session-a', { gameApiKey: 'gsk-session-a' });

  assert.equal(loadSessionConfig('owner-telegram', 'session-a').gameApiKey, 'gsk-session-a');
  assert.equal(loadSessionConfig('owner-telegram', 'session-b').gameApiKey, undefined);
  assert.equal(loadSessionMeta('owner-telegram', 'session-a')?.sessionId, 'session-a');
});


test('Tutorial manager button remains owner-scoped and uses valid escaped command markup', async () => {
  const adminButtons = callbackData(adminPanelKeyboard());
  assert.ok(adminButtons.includes('admin:tutorials'));

  let rendered = '';
  const ctx = {
    callbackQuery: {},
    answerCbQuery: async () => undefined,
    editMessageText: async (text: string) => { rendered = text; },
    reply: async () => undefined,
  } as never;
  await handleTutorialsMenu(ctx);

  assert.match(rendered, /<code>\.help &lt;command&gt;<\/code>/);
  assert.doesNotMatch(rendered, /<command>/);
});

test('ownerOnly acknowledges an unauthorized callback instead of leaving Telegram loading', async () => {
  let acknowledged = '';
  let replied = false;
  const middleware = ownerOnly();
  await middleware(
    {
      isOwner: false,
      callbackQuery: {},
      answerCbQuery: async (text?: string) => { acknowledged = text ?? ''; },
      reply: async () => { replied = true; },
    } as never,
    async () => { throw new Error('must not continue'); },
  );

  assert.equal(acknowledged, 'Owner only');
  assert.equal(replied, true);
});

test('session menu preserves the selected session identity in every Game API action', () => {
  const callbacks = callbackData(gameApiKeyboard('session-b', true));
  assert.ok(callbacks.every((value) => value === 'session:session-b:menu' || value.startsWith('session:session-b:gameapi')));
  assert.ok(!callbacks.some((value) => value.includes('session-a')));
});

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
