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
} from './ui/keyboards.js';
import { mainMenu, header, H, escape, card, noticeCard, safe } from '../utils/formatter.js';
import { getSocket, getUserSockets, isFrozen } from '../whatsapp/socket-manager.js';
import {
  loadConfig,
  loadBucket,
  loadSessionMeta,
  saveSessionMeta,
  purgeSession,
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
  };
}

function resetOnboarding(ctx: BotContext): void {
  delete ctx.session.onboarding;
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
  bot.use(authMiddleware() as Parameters<typeof bot.use>[0]);
  bot.use(forceJoinMiddleware() as Parameters<typeof bot.use>[0]);

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

  bot.command('admin', ownerOnly() as Parameters<typeof bot.use>[0], async (ctx) => {
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
  bot.command('omni', ownerOnly() as Parameters<typeof bot.use>[0], async (ctx) => {
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
        await ctx.reply(
          `${header('Bridge Mode', '🌉')}\n\n${H.italic('Command executed without posting the command text')}\n${H.code(text)}`,
          { parse_mode: 'HTML' }
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
    if (ctx.session?.awaitingPrefix) {
      ctx.session.awaitingPrefix = false;
      const { updateConfig } = await import('../services/workspace.js');
      updateConfig(ctx.telegramId, { prefix: text.trim() });
      await ctx.reply(card('Prefix Updated', '✅', [['New prefix', text.trim()]], 'New WhatsApp bridge commands will use this prefix.'), { parse_mode: 'HTML' });
      return;
    }

    // ── Auto-detect WA links → add to bucket ─────────────
    const LINK_RE = /https?:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]+/g;
    if (LINK_RE.test(text)) {
      await handleAddLinks(ctx as BotContext, text);
      return;
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
        ? `${header('Sticker Macro Help', '🎭')}\n\nSend an unbound sticker to receive its hash. Then use ${H.code('.setcmd [hash] [command]')} or reply to a sticker with ${H.code('.setcmd [command]')}.`
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
      const meta = loadSessionMeta(ctx.telegramId, sessionId);
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
    if (sub === 'bridge') { await handleBridgeSession(ctx, sessionId); return; }
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
    if (sub === 'pause') { await handleGlobalPause(ctx, params[1] !== 'off'); return; }
    if (sub === 'maintenance') { await handleMaintenanceToggle(ctx, params[1] !== 'off'); return; }
    if (sub === 'stats') { await handlePlatformStats(ctx); return; }
    return;
  }

  // ── Settings ──
  if (action === 'settings') {
    const sub = params[0];
    if (sub === 'menu') {
      const { settingsKeyboard } = await import('./ui/keyboards.js');
      await ctx.editMessageText(card('Settings', '⚙️', [['Prefix', loadConfig(ctx.telegramId).prefix]], 'Choose what you want to configure.'), {
        parse_mode: 'HTML',
        reply_markup: settingsKeyboard(),
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
        `${header('Sticker Macros', '🎭')}\n\n${H.bold('Bindings:')} ${macroCount}\n\nSend an unbound sticker in WhatsApp to get its stable hash, then bind it with ${H.code('.setcmd [hash] [command]')}.`,
        { parse_mode: 'HTML', reply_markup: stickerMacrosKeyboard() }
      );
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
