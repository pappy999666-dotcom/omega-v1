// ============================================================
// WA-Bridge — Telegraf Bot Initialization
// Telegram Bot API 9.0+ — HTML parse mode, inline keyboards
// ============================================================

import { Telegraf, session, type Context } from 'telegraf';
import { logger } from '../utils/logger.js';
import { authMiddleware, forceJoinMiddleware, ownerOnly } from './middlewares/auth.js';
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
import { mainMenuKeyboard } from './ui/keyboards.js';
import { mainMenu, header, H, escape } from '../utils/formatter.js';
import { getSocket, getUserSockets, isFrozen } from '../whatsapp/socket-manager.js';
import { loadConfig, loadBucket } from '../services/workspace.js';
import { resolveGroupJid } from '../whatsapp/commands/lifecycle.js';
import { executeBridgeCommand } from '../whatsapp/event-handlers.js';

// ── Context Extension ─────────────────────────────────────

interface BotContext extends Context {
  telegramId: string;
  isOwner: boolean;
  userConfig: ReturnType<typeof loadConfig>;
  session: {
    awaitingPhone?: boolean;
    awaitingLinks?: boolean;
    awaitingPrefix?: boolean;
    bridgeSessionId?: string;
  };
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
      await ctx.reply('Usage: /jid [group_link_or_code]');
      return;
    }

    const sessionIds = getUserSockets(ctx.telegramId);
    if (sessionIds.length === 0) {
      await ctx.reply('❌ No active WhatsApp sessions');
      return;
    }

    const socket = getSocket(sessionIds[0]!);
    if (!socket) {
      await ctx.reply('❌ Socket not ready');
      return;
    }

    const info = await resolveGroupJid(socket, link);
    if (!info) {
      await ctx.reply('❌ Could not resolve JID');
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
      await ctx.reply('Usage: /omni [broadcast|status] [text]');
      return;
    }
    await executeOmniCommand(ctx as BotContext, command, text);
  });

  // /unbind — Exit bridge mode
  bot.command('unbind', async (ctx) => {
    handleBridgeExit(ctx.telegramId);
    await ctx.reply('🌉 Bridge mode exited.');
  });

  bot.command('help', async (ctx) => {
    const text = [
      header('WA-Bridge Commands', '📖'),
      '',
      H.bold('📱 Sessions'),
      '  /sessions — Manage WhatsApp sessions',
      '  /jid [link] — Resolve group JID',
      '',
      H.bold('🗂 Bucket'),
      '  /bucket — Link validator hub',
      '  Send links directly → auto-added to main bucket',
      '',
      H.bold('🌉 Bridge Mode'),
      '  Select a session → Bridge to send WA commands',
      '  /unbind — Exit bridge mode',
      '',
      H.bold('⚙️ Bot'),
      '  /start — Main menu',
      '  /help — This message',
      ctx.isOwner ? '\n' + H.bold('👑 Owner') + '\n  /admin — Admin panel\n  /omni [cmd] [text] — Omni-bridge' : '',
    ].filter(Boolean).join('\n');

    await ctx.reply(text, { parse_mode: 'HTML' });
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
        await ctx.reply('❌ Bridge session is unavailable. /unbind to exit.');
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
        await ctx.reply(`❌ Bridge command failed: ${String(error)}`);
      }
      return;
    }

    // ── Awaiting Phone ────────────────────────────────────
    if (ctx.session?.awaitingPhone) {
      ctx.session.awaitingPhone = false;
      const phone = text.replace(/\s/g, '');
      await handleNewSession(ctx as BotContext, phone);
      return;
    }

    // ── Awaiting Prefix ───────────────��───────────────────
    if (ctx.session?.awaitingPrefix) {
      ctx.session.awaitingPrefix = false;
      const { updateConfig } = await import('../services/workspace.js');
      updateConfig(ctx.telegramId, { prefix: text.trim() });
      await ctx.reply(`✅ Prefix updated to: ${H.code(text.trim())}`, { parse_mode: 'HTML' });
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
      await ctx.answerCbQuery('An error occurred').catch(() => {});
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

  // ── Sessions ──
  if (action === 'sessions') {
    const page = parseInt(params[1] ?? '0', 10);
    await handleSessionsList(ctx, page);
    return;
  }

  if (action === 'session') {
    if (params[0] === 'new') {
      ctx.session.awaitingPhone = true;
      await ctx.editMessageText(
        `${header('Add New Session', '➕')}\n\nSend your phone number in international format:\n${H.code('+1234567890')}`,
        { parse_mode: 'HTML' }
      );
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
        sessionCard({ sessionId, phone: meta.phone, status: meta.status, paired: meta.status === 'open' }),
        { parse_mode: 'HTML', reply_markup: sessionMenuKeyboard(sessionId) }
      ).catch(() => {});
      return;
    }
    if (sub === 'info') { await handleSessionInfo(ctx, sessionId); return; }
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
    if (method === 'code' && sessionId) {
      const { loadSessionMeta } = await import('../services/workspace.js');
      const meta = loadSessionMeta(ctx.telegramId, sessionId);
      if (meta) await handlePairingCode(ctx, sessionId, meta.phone);
    }
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
    if (sub === 'pause') { await handleGlobalPause(ctx, true); return; }
    if (sub === 'maintenance') { await handleMaintenanceToggle(ctx, true); return; }
    if (sub === 'stats') { await handlePlatformStats(ctx); return; }
    return;
  }

  // ── Settings ──
  if (action === 'settings') {
    const sub = params[0];
    if (sub === 'menu') {
      const { settingsKeyboard } = await import('./ui/keyboards.js');
      await ctx.editMessageText(header('Settings', '⚙️'), {
        parse_mode: 'HTML',
        reply_markup: settingsKeyboard(),
      });
      return;
    }
    if (sub === 'prefix') {
      ctx.session.awaitingPrefix = true;
      await ctx.editMessageText(
        `${header('Change Prefix', '🔤')}\n\nSend your new command prefix (e.g. ${H.code('!')}, ${H.code('/')})\nOr send ${H.code('null')} to enable always-listen mode.`,
        { parse_mode: 'HTML' }
      );
      return;
    }
    return;
  }

  // Default fallback
  await ctx.answerCbQuery().catch(() => {});
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
