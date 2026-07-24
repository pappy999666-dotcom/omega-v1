// ============================================================
// WA-Bridge — Telegraf Bot Initialization
// Telegram Bot API 9.0+ — HTML parse mode, inline keyboards
// ============================================================

import { Telegraf, session, type Context } from 'telegraf';
import { logger } from '../utils/logger.js';
import {
  authMiddleware,
  forceJoinMiddleware,
  ownerOnly,
  type SessionOnboardingDraft,
} from './middlewares/auth.js';
import {
  handleSessionsList,
  handleNewSession,
  handlePairingCode,
  handleSessionInfo,
  handleFreezeSession,
  handleUnfreezeSession,
  handleReinitSession,
  handlePurgeSession,
  handlePurgeConfirm,
  handleBridgeSession,
  handleBridgeExit,
  getBridgeSession,
  handleLinkCollection,
  handleJoinManager,
} from './handlers/session.js';
import {
  handleBucketStatus,
  handleBucketView,
  handleAddLinks,
  handleStartFilter,
  handleStopFilter,
  handleExportBucket,
  handlePurgeDead,
  handleMergeBuckets,
} from './handlers/bucket.js';
import {
  handleAdminPanel,
  handleAdminUsers,
  handleAdminUserMenu,
  handleBanUser,
  handleInspectUser,
  handlePurgeUserSessions,
  handlePurgeConfirm as adminPurgeConfirm,
  handleMasterBucket,
  handleOmniBridge,
  executeOmniCommand,
  handleGlobalPause,
  handleMaintenanceToggle,
  handlePlatformStats,
} from './handlers/admin.js';
import {
  mainMenuKeyboard,
  helpKeyboard,
  statusKeyboard,
  stickerMacrosKeyboard,
  backKeyboard,
  sessionPairKeyboard,
  sessionWizardKeyboard,
  sleepKeyboard,
  supportKeyboard,
  settingsKeyboard,
} from './ui/keyboards.js';
import { mainMenu, header, H, escape, card, noticeCard, safe } from '../utils/formatter.js';
import { getSocket, getUserSockets, isFrozen } from '../whatsapp/socket-manager.js';
import {
  loadConfig,
  loadBucket,
  loadSessionMeta,
  saveSessionMeta,
  purgeSession,
  updateConfig,
  findSessionOwner,
} from '../services/workspace.js';
import { normalizePairingPhone } from '../whatsapp/socket-manager.js';
import { resolveGroupJid } from '../whatsapp/commands/lifecycle.js';
import { executeBridgeCommand } from '../whatsapp/event-handlers.js';

// ── Context Extension ─────────────────────────────────────

interface BotContext extends Context {
  telegramId: string;
  isOwner: boolean;
  userConfig: ReturnType<typeof loadConfig>;
  session: {
    onboarding?: SessionOnboardingDraft;
    awaitingLinks?: boolean;
    awaitingPrefix?: boolean;
    bridgeSessionId?: string;
    awaitingGlobalBridge?: boolean;
    awaitingSupport?: boolean;
    awaitingProfilePhotoSessionId?: string;
    awaitingForceJoin?: boolean;
    awaitingBroadcast?: boolean;
  };
}

function resetOnboarding(ctx: BotContext): void {
  delete ctx.session.onboarding;
}

function sessionOwner(ctx: BotContext, sessionId: string): string {
  return ctx.isOwner ? findSessionOwner(sessionId) ?? ctx.telegramId : ctx.telegramId;
}

function makeDraftSessionId(telegramId: string, phone: string): string {
  return `1_${telegramId}_${phone.replace(/\D/g, '')}`;
}

function onboardingNameCard(): string {
  return card(
    'New Session — Step 1 of 3',
    '🏷️',
    [['Required', 'Session name']],
    'Send a friendly name such as Sales Line, Personal, or Support.'
  );
}

function onboardingPhoneCard(label: string): string {
  return card(
    'New Session — Step 2 of 3',
    '📱',
    [['Name', label], ['Required', 'WhatsApp owner number']],
    'Send the full international number, for example +2348012345678.'
  );
}

function onboardingMethodCard(label: string, phone: string): string {
  return card(
    'New Session — Step 3 of 3',
    '🔗',
    [['Name', label], ['Owner', phone]],
    'Choose exactly how you want to connect this WhatsApp account.'
  );
}

function helpText(isOwner: boolean): string {
  const commands = [
    '/sessions — Manage WhatsApp sessions',
    '/jid [link] — Resolve a group JID',
    '/bucket — Open the link validator hub',
    '/unbind — Exit bridge mode',
    '/start — Open the control center',
    '/help — Show this reference',
    ...(isOwner ? ['/admin — Platform governance', '/omni [command] [text] — Omni-bridge'] : []),
  ].join('\n');
  return [
    header('WA-Bridge Commands', '📖'),
    '',
    H.blockquote('Tap the menu buttons for guided controls. Use commands when you need a shortcut.'),
    '',
    H.blockquote(`${H.bold('Command reference')}\n${H.pre(commands, 'text')}`, true),
  ].join('\n');
}

// ── Bot Factory ───────────────────────────────────────────

export function createBot(): Telegraf<BotContext> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');

  const bot = new Telegraf<BotContext>(token, {
    handlerTimeout: 300_000, // 5 min for long operations
  });

  // ── Session Store ──────────────────────────────────────
  bot.use(session({ defaultSession: () => ({}) }));

  // ── Auth Middleware ────────────────────────────────────
  bot.use(authMiddleware() as never);
  bot.use(forceJoinMiddleware() as never);

  // ── Commands ───────────────────────────────────────────

  bot.command('start', async (ctx) => {
    resetOnboarding(ctx);
    await ctx.reply(
      mainMenu(ctx.telegramId, ctx.isOwner),
      { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(ctx.isOwner) }
    );
  });

  bot.command('sessions', async (ctx) => {
    await handleSessionsList(ctx as BotContext);
  });

  bot.command('bucket', async (ctx) => {
    await handleBucketStatus(ctx as BotContext);
  });

  bot.command('admin', ownerOnly() as never, async (ctx) => {
    await handleAdminPanel(ctx);
  });

  // /jid [link] — resolve group JID (admin utility)
  bot.command('jid', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const link = args[0];
    if (!link) {
      await ctx.reply(card('Resolve Group JID', '🔑', [['Usage', '/jid [group link or code]']], 'Provide a WhatsApp invite link or invite code.'), { parse_mode: 'HTML' });
      return;
    }

    const sessionIds = getUserSockets(ctx.telegramId);
    if (sessionIds.length === 0) {
      await ctx.reply(noticeCard('No Active Session', 'Connect a WhatsApp session before resolving group details.', 'warning'), { parse_mode: 'HTML' });
      return;
    }

    const socket = getSocket(sessionIds[0]!);
    if (!socket) {
      await ctx.reply(noticeCard('Session Unavailable', 'The selected WhatsApp socket is not ready yet.', 'warning'), { parse_mode: 'HTML' });
      return;
    }

    const info = await resolveGroupJid(socket, link);
    if (!info) {
      await ctx.reply(noticeCard('JID Not Found', 'The invite could not be resolved. Check that it is valid and still active.', 'error'), { parse_mode: 'HTML' });
      return;
    }

    await ctx.reply(
      [
        header('Group JID Resolved', '🔑'),
        '',
        H.bold('JID:') + ' ' + H.code(info.jid),
        H.bold('Title:') + ' ' + escape(info.title),
        H.bold('Members:') + ' ' + info.members,
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
  });

  // /omni [cmd] [text] — Admin omni-bridge command
  bot.command('omni', ownerOnly() as never, async (ctx) => {
    const parts = ctx.message.text.split(' ').slice(1);
    const command = parts[0];
    const text = parts.slice(1).join(' ');
    if (!command) {
      await ctx.reply(card('Omni-Bridge', '📡', [['Usage', '/omni [broadcast|status] [text]']], 'Choose an operation and provide its content.'), { parse_mode: 'HTML' });
      return;
    }
    await executeOmniCommand(ctx as BotContext, command, text);
  });

  // /unbind — Exit bridge mode
  bot.command('unbind', async (ctx) => {
    handleBridgeExit(ctx.telegramId);
    await ctx.reply(noticeCard('Bridge Closed', 'Bridge mode has been safely exited.', 'success'), {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(ctx.isOwner),
    });
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(helpText(ctx.isOwner), {
      parse_mode: 'HTML',
      reply_markup: helpKeyboard(),
    });
  });

  // ── Text Message Handler ──────────────────────────────

  bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return; // Let command handlers catch it

    if (ctx.session?.awaitingForceJoin) {
      ctx.session.awaitingForceJoin = false;
      const targets = [...new Set(text.split(/[\s,]+/u).map((target) => target.trim()).filter(Boolean))];
      const verified: string[] = [];
      for (const target of targets) {
        try {
          await ctx.telegram.getChat(target);
          verified.push(target);
        } catch (error) {
          logger.warn('[Bot] Force-join target verification failed', { target, error: String(error) });
        }
      }
      updateConfig(ctx.telegramId, { forceJoinTargets: verified });
      await ctx.reply(card('Force Join Updated', '🔐', [['Saved targets', String(verified.length)]], verified.join('\n') || 'Force join is disabled.'), { parse_mode: 'HTML' });
      return;
    }

    if (ctx.session?.awaitingBroadcast) {
      ctx.session.awaitingBroadcast = false;
      const { getAllUserIds } = await import('../services/workspace.js');
      let sent = 0;
      let failed = 0;
      for (const id of getAllUserIds()) {
        try { await ctx.telegram.sendMessage(Number(id), text); sent++; }
        catch { failed++; }
      }
      await ctx.reply(card('Broadcast Complete', '📣', [['Sent', String(sent)], ['Failed', String(failed)]], 'Text broadcast delivered to registered users.'), { parse_mode: 'HTML' });
      return;
    }

    // ── Bridge Mode ──────────────────────────────────────
    const bridgeSessionId = getBridgeSession(ctx.telegramId);
    if (bridgeSessionId) {
      const socket = getSocket(bridgeSessionId);
      if (!socket || isFrozen(bridgeSessionId)) {
        await ctx.reply(noticeCard('Bridge Unavailable', 'This session is disconnected or frozen. Use /unbind to exit bridge mode.', 'warning'), { parse_mode: 'HTML' });
        return;
      }

      try {
        await executeBridgeCommand(
          bridgeSessionId,
          ctx.telegramId,
          text,
          socket,
          async (response) => {
            await ctx.reply(response);
          }
        );
      } catch (error) {
        logger.error('[Bot] Bridge command failed', {
          bridgeSessionId,
          error: String(error),
        });
        await ctx.reply(noticeCard('Bridge Command Failed', 'The WhatsApp command could not be completed.', 'error', String(error)), { parse_mode: 'HTML' });
      }
      return;
    }

    // ── Session Onboarding Wizard ──────────────────────────
    const onboarding = ctx.session?.onboarding;
    if (onboarding?.stage === 'name') {
      const label = text.trim().replace(/\s+/g, ' ').slice(0, 40);
      if (label.length < 2) {
        await ctx.reply(noticeCard('Name Required', 'Use at least 2 characters for the session name.', 'warning'), {
          parse_mode: 'HTML',
          reply_markup: sessionWizardKeyboard(),
        });
        return;
      }
      ctx.session.onboarding = { stage: 'phone', label };
      await ctx.reply(onboardingPhoneCard(label), {
        parse_mode: 'HTML',
        reply_markup: sessionWizardKeyboard(),
      });
      return;
    }

    if (onboarding?.stage === 'phone' && onboarding.label) {
      let phone: string;
      try {
        phone = normalizePairingPhone(text);
      } catch (error) {
        await ctx.reply(noticeCard(
          'Invalid Owner Number',
          error instanceof Error ? error.message : 'Enter a valid international WhatsApp number.',
          'error'
        ), { parse_mode: 'HTML', reply_markup: sessionWizardKeyboard() });
        return;
      }

      const sessionId = makeDraftSessionId(ctx.telegramId, phone);
      const existing = loadSessionMeta(ctx.telegramId, sessionId);
      if (existing?.status === 'open') {
        resetOnboarding(ctx);
        await ctx.reply(noticeCard('Session Already Connected', `${onboarding.label} is already active for ${phone}.`, 'warning'), {
          parse_mode: 'HTML',
          reply_markup: backKeyboard('sessions:list'),
        });
        return;
      }

      saveSessionMeta({
        ...(existing ?? {
          sessionId,
          telegramId: ctx.telegramId,
          autoJoinDone: false,
          errorCount: 0,
        }),
        label: onboarding.label,
        phone,
        status: 'closed',
        pairMethod: existing?.pairMethod ?? 'qr',
      });
      ctx.session.onboarding = { stage: 'method', label: onboarding.label, phone, sessionId };
      await ctx.reply(onboardingMethodCard(onboarding.label, phone), {
        parse_mode: 'HTML',
        reply_markup: sessionPairKeyboard(sessionId),
      });
      return;
    }

    // ── Awaiting Prefix ───────────────��───────────────────
    if (ctx.session?.awaitingGlobalBridge) {
    ctx.session.awaitingGlobalBridge = false;
    const sessionIds = getUserSockets(ctx.telegramId);
    const results = await Promise.allSettled(sessionIds.map(async (sessionId) => {
      const socket = getSocket(sessionId);
      if (!socket || isFrozen(sessionId)) throw new Error('Unavailable');
      const replies: string[] = [];
      await executeBridgeCommand(sessionId, ctx.telegramId, text, socket, async (response) => { replies.push(response); });
      return `${sessionId}: ${replies.at(-1) ?? 'Completed'}`;
    }));
    const summary = results.map((result, index) => result.status === 'fulfilled'
      ? `OK ${result.value}`
      : `FAILED ${sessionIds[index]}: ${String(result.reason)}`).join('\n');
    await ctx.reply(`${header('Global Bridge Complete', '📡')}\n\n${H.pre(summary || 'No connected sessions.', 'log')}`, {
      parse_mode: 'HTML', reply_markup: mainMenuKeyboard(ctx.isOwner),
    });
    return;
  }

  if (ctx.session?.awaitingSupport) {
    ctx.session.awaitingSupport = false;
    const supportId = process.env.TELEGRAM_SUPPORT_CHAT_ID || process.env.TELEGRAM_OWNER_ID;
    if (!supportId) {
      await ctx.reply(noticeCard('Support Not Configured', 'Set TELEGRAM_SUPPORT_CHAT_ID to receive support messages.', 'error'), { parse_mode: 'HTML' });
      return;
    }
    await ctx.telegram.sendMessage(supportId, `Support from ${ctx.telegramId}:\n\n${text}`);
    await ctx.reply(noticeCard('Support Message Sent', 'Your message was delivered to the support team.', 'success'), { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(ctx.isOwner) });
    return;
  }

  if (ctx.session?.awaitingPrefix) {
      ctx.session.awaitingPrefix = false;
      const { updateConfig } = await import('../services/workspace.js');
      const requestedPrefix = text.trim();
      const nullPrefix = requestedPrefix.toLowerCase() === 'null';
      updateConfig(ctx.telegramId, { prefix: nullPrefix ? '' : requestedPrefix, nullPrefix });
      await ctx.reply(card('Prefix Updated', '✅', [['New prefix', nullPrefix ? 'Exact commands only (no prefix)' : requestedPrefix]], 'Ordinary WhatsApp conversation remains silent.'), { parse_mode: 'HTML' });
      return;
    }

    // ── Auto-detect WA links → add to bucket ─────────────
    const LINK_RE = /https?:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]+/g;
    if (LINK_RE.test(text)) {
      await handleAddLinks(ctx as BotContext, text);
      return;
    }
  });

  bot.on('photo', async (ctx) => {
    if (ctx.session?.awaitingBroadcast) {
      ctx.session.awaitingBroadcast = false;
      const { getAllUserIds } = await import('../services/workspace.js');
      const photo = ctx.message.photo.at(-1);
      if (!photo) return;
      let sent = 0;
      let failed = 0;
      for (const id of getAllUserIds()) {
        try { await ctx.telegram.sendPhoto(Number(id), photo.file_id, { caption: ctx.message.caption }); sent++; }
        catch { failed++; }
      }
      await ctx.reply(card('Broadcast Complete', '📣', [['Sent', String(sent)], ['Failed', String(failed)]], 'Photo broadcast delivered.'), { parse_mode: 'HTML' });
      return;
    }
    const sessionId = ctx.session?.awaitingProfilePhotoSessionId;
    if (!sessionId) return;
    delete ctx.session.awaitingProfilePhotoSessionId;
    const socket = getSocket(sessionId);
    if (!socket || isFrozen(sessionId)) {
      await ctx.reply(noticeCard('Profile Photo Failed', 'The selected WhatsApp session is not connected.', 'warning'), { parse_mode: 'HTML' });
      return;
    }
    try {
      const photo = ctx.message.photo.at(-1);
      if (!photo) throw new Error('Telegram did not provide a usable photo');
      const fileUrl = await ctx.telegram.getFileLink(photo.file_id);
      const response = await fetch(fileUrl);
      if (!response.ok) throw new Error(`Telegram download failed with ${response.status}`);
      const image = Buffer.from(await response.arrayBuffer());
      const ownJid = (socket as { user?: { id?: string } }).user?.id;
      if (!ownJid) throw new Error('The WhatsApp account JID is unavailable');
      await (socket as unknown as { updateProfilePicture(jid: string, image: Buffer): Promise<void> }).updateProfilePicture(ownJid, image);
      await ctx.reply(noticeCard('Profile Photo Updated', 'The WhatsApp profile photo was changed successfully.', 'success'), {
        parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`),
      });
    } catch (error) {
      logger.error('[Bot] Profile photo update failed', { sessionId, error: String(error) });
      await ctx.reply(noticeCard('Profile Photo Failed', 'WhatsApp could not update the profile photo.', 'error', String(error)), {
        parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`),
      });
    }
  });


  bot.on('document', async (ctx) => {
    if (ctx.session?.awaitingBroadcast) {
      ctx.session.awaitingBroadcast = false;
      const { getAllUserIds } = await import('../services/workspace.js');
      let sent = 0;
      let failed = 0;
      for (const id of getAllUserIds()) {
        try { await ctx.telegram.sendDocument(Number(id), ctx.message.document.file_id, { caption: ctx.message.caption }); sent++; }
        catch { failed++; }
      }
      await ctx.reply(card('Broadcast Complete', '📣', [['Sent', String(sent)], ['Failed', String(failed)]], 'Document broadcast delivered.'), { parse_mode: 'HTML' });
      return;
    }
    const name = ctx.message.document.file_name ?? '';
    if (!/\.(txt|csv|json)$/iu.test(name)) return;
    try {
      const fileUrl = await ctx.telegram.getFileLink(ctx.message.document.file_id);
      const response = await fetch(fileUrl);
      if (!response.ok) throw new Error(`Telegram download failed with ${response.status}`);
      const { importLinksToMainBucket } = await import('../services/importer.js');
      const result = importLinksToMainBucket(ctx.telegramId, await response.text());
      await ctx.reply(card('Document Imported', '📥', [['Extracted', String(result.extracted)], ['Unique', String(result.unique)], ['Added', String(result.added)], ['Duplicates', String(result.dupes)]], 'Links were parsed, deduplicated, and inserted into Main Bucket.'), { parse_mode: 'HTML' });
    } catch (error) {
      await ctx.reply(noticeCard('Import Failed', 'The document could not be imported.', 'error', String(error)), { parse_mode: 'HTML' });
    }
  });

  // ── Callback Query Router ──────────────────────────────

  bot.on('callback_query', async (ctx) => {
    const data = (ctx.callbackQuery as { data?: string }).data;
    if (!data) return;

    const bc = ctx as BotContext;

    // Pattern: action:param1:param2:...
    const [action, ...params] = data.split(':');

    try {
      await ctx.answerCbQuery().catch(() => {});
      await routeCallback(bc, action!, params);
    } catch (err) {
      logger.error('[Bot] Callback error', { data, err: String(err) });
      await ctx.reply(noticeCard('Action Failed', 'The selected action could not be completed.', 'error', String(err)), {
        parse_mode: 'HTML',
      }).catch(() => {});
    }
  });

  // ── Force Join Verify ──────────────────────────────────

  bot.action('verify:joined', async (ctx) => {
    await ctx.answerCbQuery('Checking membership…');
    // Re-trigger the middleware on next interaction — just dismiss
    await ctx.deleteMessage().catch(() => {});
    await ctx.reply(
      mainMenu(ctx.telegramId, ctx.isOwner),
      { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(ctx.isOwner) }
    );
  });

  // ── Error Handler ──────────────────────────────────────

  bot.catch((err, ctx) => {
    logger.error('[Bot] Unhandled error', {
      err: String(err),
      update: ctx.updateType,
    });
  });

  return bot;
}

// ── Callback Route Table ──────────────────────────────────

async function routeCallback(
  ctx: BotContext,
  action: string,
  params: string[]
): Promise<void> {
  // ── Menu ──
  if (action === 'menu' && params[0] === 'main') {
    await ctx.editMessageText(mainMenu(ctx.telegramId, ctx.isOwner), {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(ctx.isOwner),
    });
    return;
  }

  // ── Help and Status ──
  if (action === 'help') {
    const stickerHelp = params[0] === 'stickers';
    await ctx.editMessageText(
      stickerHelp
        ? `${header('Sticker Macro Help', '🎭')}\n\nUnbound stickers stay silent. Reply directly to the sticker with ${H.code('.setcmd [command]')} to bind it.`
        : helpText(ctx.isOwner),
      {
        parse_mode: 'HTML',
        reply_markup: stickerHelp ? backKeyboard('settings:macros') : helpKeyboard(),
      }
    );
    return;
  }

  if (action === 'status' && params[0] === 'overview') {
    const sessionIds = getUserSockets(ctx.telegramId);
    const active = sessionIds.filter((id) => Boolean(getSocket(id)) && !isFrozen(id)).length;
    const frozen = sessionIds.filter((id) => isFrozen(id)).length;
    const bucketTotal = loadBucket(ctx.telegramId, 'main').length;
    await ctx.editMessageText(
      card('System Status', '📊', [
        ['Bot', 'Online'],
        ['Sessions', String(sessionIds.length)],
        ['Active', String(active)],
        ['Frozen', String(frozen)],
        ['Pending links', String(bucketTotal)],
      ], 'Use Refresh to request the latest runtime snapshot.'),
      { parse_mode: 'HTML', reply_markup: statusKeyboard() }
    );
    return;
  }

  // ── Sessions ──
  if (action === 'sessions') {
    const page = parseInt(params[1] ?? '0', 10);
    await handleSessionsList(ctx, page);
    return;
  }

  if (action === 'session') {
    if (params[0] === 'new' && params[1] === 'cancel') {
      const draftSessionId = ctx.session.onboarding?.sessionId;
      if (draftSessionId && loadSessionMeta(ctx.telegramId, draftSessionId)?.status === 'closed') {
        purgeSession(ctx.telegramId, draftSessionId);
      }
      resetOnboarding(ctx);
      await handleSessionsList(ctx);
      return;
    }

    if (params[0] === 'new') {
      ctx.session.onboarding = { stage: 'name' };
      await ctx.editMessageText(onboardingNameCard(), {
        parse_mode: 'HTML',
        reply_markup: sessionWizardKeyboard(),
      });
      return;
    }

    const sessionId = params[0]!;
    const sub = params[1];
    if (!sessionId || !sub) return;

    if (sub === 'menu') {
      const { sessionMenuKeyboard } = await import('./ui/keyboards.js');
      const { loadSessionMeta } = await import('../services/workspace.js');
      const ownerId = sessionOwner(ctx, sessionId);
      const meta = loadSessionMeta(ownerId, sessionId);
      if (!meta) { await ctx.answerCbQuery('Session not found'); return; }
      const { sessionCard } = await import('../utils/formatter.js');
      await ctx.editMessageText(
        sessionCard({ sessionId, label: meta.label, phone: meta.phone, status: meta.status, paired: meta.status === 'open' }),
        { parse_mode: 'HTML', reply_markup: sessionMenuKeyboard(sessionId) }
      ).catch(() => {});
      return;
    }
    if (sub === 'info') { await handleSessionInfo(ctx, sessionId); return; }
    if (sub === 'groups') {
      const socket = getSocket(sessionId);
      if (!socket) {
        await ctx.editMessageText(noticeCard('Session Groups', 'Connect this session before requesting its group list.', 'warning'), {
          parse_mode: 'HTML',
          reply_markup: backKeyboard(`session:${sessionId}:menu`),
        });
        return;
      }
      const groups = await socket.groupFetchAllParticipating();
      const names = Object.values(groups).slice(0, 50).map((group, index) => `${index + 1}. ${escape(group.subject)}`);
      await ctx.editMessageText(
        [
          card('Session Groups', '📋', [['Total shown', String(names.length)]], names.length ? 'Open the expandable section to review group names.' : 'No groups were found.'),
          names.length ? H.blockquote(names.join('\n'), true) : '',
        ].filter(Boolean).join('\n\n'),
        { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`) }
      );
      return;
    }
    if (sub === 'freeze') { await handleFreezeSession(ctx, sessionId); return; }
    if (sub === 'unfreeze') { await handleUnfreezeSession(ctx, sessionId); return; }
    if (sub === 'reinit') { await handleReinitSession(ctx, sessionId); return; }
    if (sub === 'purge' && params[2] === 'confirm') { await handlePurgeConfirm(ctx, sessionId); return; }
    if (sub === 'purge') { await handlePurgeSession(ctx, sessionId); return; }
    if (sub === 'pfp') {
      const operation = params[2];
      const socket = getSocket(sessionId);
      if (!socket || isFrozen(sessionId)) {
        await ctx.answerCbQuery('Session is not connected', { show_alert: true }).catch(() => {});
        return;
      }
      if (operation === 'set') {
        ctx.session.awaitingProfilePhotoSessionId = sessionId;
        await ctx.editMessageText(card('Set WhatsApp Profile Photo', '🖼', [['Session', sessionId]], 'Send one photo now. Use a square image for the best result.'), {
          parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`),
        });
      } else if (operation === 'remove') {
        const ownJid = (socket as { user?: { id?: string } }).user?.id;
        if (!ownJid) throw new Error('The WhatsApp account JID is unavailable');
        await (socket as unknown as { removeProfilePicture(jid: string): Promise<void> }).removeProfilePicture(ownJid);
        await ctx.editMessageText(noticeCard('Profile Photo Removed', 'The WhatsApp profile photo was removed.', 'success'), {
          parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`),
        });
      }
      return;
    }
    if (sub === 'bridge') { await handleBridgeSession(ctx, sessionId); return; }
    if (sub === 'collect') {
      const enabled = params[2] === 'on' ? true : params[2] === 'off' ? false : undefined;
      await handleLinkCollection(ctx, sessionId, enabled);
      return;
    }
    if (sub === 'joinmgr') { await handleJoinManager(ctx, sessionId); return; }
    if (sub === 'join') {
      const operation = params[2] as 'start' | 'pause' | 'stop' | undefined;
      await handleJoinManager(ctx, sessionId, operation);
      return;
    }
    return;
  }

  // ── Pairing ──
  if (action === 'pair') {
    const method = params[0];
    const sessionId = params[1];
    if (!sessionId) return;
    const meta = loadSessionMeta(ctx.telegramId, sessionId);
    if (!meta) {
      await ctx.answerCbQuery('Session not found', { show_alert: true }).catch(() => {});
      return;
    }
    resetOnboarding(ctx);
    if (method === 'code') await handlePairingCode(ctx, sessionId, meta.phone);
    else if (method === 'qr') await handleNewSession(ctx, meta.phone, meta.label);
    return;
  }

  // ── Bucket ──
  if (action === 'bucket') {
    const sub = params[0];
    if (sub === 'status') { await handleBucketStatus(ctx); return; }
    if (sub === 'view') { await handleBucketView(ctx, params[1] as 'main' | 'active' | 'dead', 0); return; }
    if (sub === 'filter') {
      if (params[1] === 'start') await handleStartFilter(ctx);
      else await handleStopFilter(ctx);
      return;
    }
    if (sub === 'export') { await handleExportBucket(ctx, params[1] as 'txt' | 'csv' | 'html'); return; }
    if (sub === 'purge' && params[1] === 'dead') { await handlePurgeDead(ctx); return; }
    if (sub === 'merge') { await handleMergeBuckets(ctx); return; }
    if (sub === 'page') { await handleBucketView(ctx, params[1] as 'main' | 'active' | 'dead', parseInt(params[2] ?? '0', 10)); return; }
    return;
  }

  // ── Bridge ──
  if (action === 'bridge' && params[0] === 'exit') {
    handleBridgeExit(ctx.telegramId);
    await ctx.answerCbQuery('Bridge exited');
    await ctx.editMessageText(mainMenu(ctx.telegramId, ctx.isOwner), {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(ctx.isOwner),
    });
    return;
  }

  // ── Admin ──
  if (action === 'admin') {
    const sub = params[0];
    if (sub === 'panel') { await handleAdminPanel(ctx); return; }
    if (sub === 'users') { await handleAdminUsers(ctx, parseInt(params[1] ?? '0', 10)); return; }
    if (sub === 'user') { await handleAdminUserMenu(ctx, params[1]!); return; }
    if (sub === 'ban') { await handleBanUser(ctx, params[1]!, true); return; }
    if (sub === 'unban') { await handleBanUser(ctx, params[1]!, false); return; }
    if (sub === 'inspect') { await handleInspectUser(ctx, params[1]!); return; }
    if (sub === 'purge_sessions') { await handlePurgeUserSessions(ctx, params[1]!); return; }
    if (sub === 'purge_confirm') { await adminPurgeConfirm(ctx, params[1]!); return; }
    if (sub === 'master') {
      if (params[1] === 'bucket') await handleMasterBucket(ctx);
      else if (params[1] === 'export') {
        const { getMasterActiveBucket } = await import('../services/tri-bucket.js');
        const { getAllUserIds, exportDir } = await import('../services/workspace.js');
        const master = getMasterActiveBucket(getAllUserIds());
        const { saveBucket } = await import('../services/workspace.js');
        saveBucket(ctx.telegramId, 'active', master);
        await handleExportBucket(ctx, params[2] as 'txt' ?? 'txt');
      }
      return;
    }
    if (sub === 'omni') { await handleOmniBridge(ctx); return; }
    if (sub === 'forcejoin') {
      ctx.session.awaitingForceJoin = true;
      await ctx.editMessageText(card('Force Join Targets', '🔐', [['Mode', 'Replace all targets']], 'Send @channels or numeric chat IDs separated by spaces/commas. Every target is verified before saving.'), { parse_mode: 'HTML', reply_markup: backKeyboard('admin:panel') });
      return;
    }
    if (sub === 'broadcast') {
      ctx.session.awaitingBroadcast = true;
      await ctx.editMessageText(card('Broadcast', '📣', [['Recipients', 'All registered users']], 'Send broadcast text or a photo now.'), { parse_mode: 'HTML', reply_markup: backKeyboard('admin:panel') });
      return;
    }
    if (sub === 'pause') { await handleGlobalPause(ctx, params[1] !== 'off'); return; }
    if (sub === 'maintenance') { await handleMaintenanceToggle(ctx, params[1] !== 'off'); return; }
    if (sub === 'stats') { await handlePlatformStats(ctx); return; }
    return;
  }

  // ── Global Bridge, Sleep, and Support ──
  if (action === 'bridge' && params[0] === 'global') {
    ctx.session.awaitingGlobalBridge = true;
    await ctx.editMessageText(card('Global Bridge', '📡', [['Connected sessions', String(getUserSockets(ctx.telegramId).length)]], 'Send one registered WhatsApp command. It will run independently on every available session.'), {
      parse_mode: 'HTML', reply_markup: backKeyboard('menu:main'),
    });
    return;
  }
  if (action === 'sleep') {
    const { updateConfig } = await import('../services/workspace.js');
    const current = loadConfig(ctx.telegramId);
    const sleeping = params[0] === 'on' ? true : params[0] === 'off' ? false : current.sleeping;
    if (params[0] === 'on' || params[0] === 'off') updateConfig(ctx.telegramId, { sleeping });
    await ctx.editMessageText(card('Sleep Mode', '🌙', [['Status', sleeping ? 'Sleeping' : 'Active']], sleeping ? 'WhatsApp command activity is silently ignored across all sessions.' : 'All sessions can process authorized commands.'), {
      parse_mode: 'HTML', reply_markup: sleepKeyboard(Boolean(sleeping)),
    });
    return;
  }
  if (action === 'support') {
    if (params[0] === 'start') {
      ctx.session.awaitingSupport = true;
      await ctx.editMessageText(card('Contact Support', '🛟', [], 'Send your support message now. It will be forwarded with your Telegram ID.'), { parse_mode: 'HTML', reply_markup: backKeyboard('support:menu') });
    } else {
      await ctx.editMessageText(card('Support', '🛟', [], 'Contact the support team without leaving the bot.'), { parse_mode: 'HTML', reply_markup: supportKeyboard() });
    }
    return;
  }

  // ── Settings ──
  if (action === 'settings') {
    const sub = params[0];
    if (sub === 'menu') {
      const config = loadConfig(ctx.telegramId);
      await ctx.editMessageText(card('Settings', '⚙️', [['Prefix', config.prefix]], 'Choose what you want to configure.'), {
        parse_mode: 'HTML',
        reply_markup: settingsKeyboard(config),
      });
      return;
    }
    if (sub === 'prefix') {
      ctx.session.awaitingPrefix = true;
      await ctx.editMessageText(
        card('Change Prefix', '🔤', [['Current', loadConfig(ctx.telegramId).prefix]], 'Send a new prefix such as ! or /. Send null to enable always-listen mode.'),
        { parse_mode: 'HTML', reply_markup: backKeyboard('settings:menu') }
      );
      return;
    }
    if (sub === 'macros') {
      const macroCount = Object.keys(loadConfig(ctx.telegramId).stickerMacros ?? {}).length;
      await ctx.editMessageText(
        `${header('Sticker Macros', '🎭')}\n\n${H.bold('Bindings:')} ${macroCount}\n\nReply directly to a WhatsApp sticker with ${H.code('.setcmd [command]')}. Unbound stickers remain silent.`,
        { parse_mode: 'HTML', reply_markup: stickerMacrosKeyboard() }
      );
      return;
    }
    if (sub === 'disabled') {
      await ctx.answerCbQuery('This option is coming soon', { show_alert: true }).catch(() => {});
      return;
    }
    if (['notifications', 'collection', 'validation'].includes(sub ?? '')) {
      const { updateConfig } = await import('../services/workspace.js');
      const config = loadConfig(ctx.telegramId);
      if (sub === 'notifications') updateConfig(ctx.telegramId, { notificationsEnabled: config.notificationsEnabled === false });
      if (sub === 'collection') updateConfig(ctx.telegramId, { defaultLinkCollection: !config.defaultLinkCollection });
      if (sub === 'validation') updateConfig(ctx.telegramId, { autoValidationEnabled: !config.autoValidationEnabled });
      const updated = loadConfig(ctx.telegramId);
      await ctx.editMessageText(card('Settings', '⚙️', [['Prefix', updated.prefix]], 'Setting updated.'), {
        parse_mode: 'HTML', reply_markup: settingsKeyboard(updated),
      });
      return;
    }
    return;
  }

  // Default fallback: never leave a rendered button apparently unresponsive.
  await ctx.reply(noticeCard(
    'Unsupported Action',
    'This button is not available in the current bot version.',
    'warning',
    [action, ...params].join(':')
  ), { parse_mode: 'HTML' });
}

// ── Alert Sender (used by socket manager) ────────────────

export function createAlertSender(
  bot: Telegraf<BotContext>
): (telegramId: string, msg: string) => Promise<void> {
  return async (telegramId, msg) => {
    try {
      await bot.telegram.sendMessage(parseInt(telegramId, 10), msg, {
        parse_mode: 'HTML',
      });
    } catch (err) {
      logger.warn('[Bot] Failed to send alert', { telegramId, err: String(err) });
    }
  };
}
