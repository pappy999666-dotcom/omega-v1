// ============================================================
// WA-Bridge — Auth & Gatekeeping Middleware
// Ban check, maintenance mode, force-join channel verification
// ============================================================

import type { Context, MiddlewareFn } from 'telegraf';
import { loadConfig, initWorkspace } from '../../services/workspace.js';
import { logger } from '../../utils/logger.js';

// ── Maintenance Mode ──────────────────────────────────────

let maintenanceMode = process.env.MAINTENANCE_MODE === 'true';
let globalPaused = false;

export function setMaintenanceMode(enabled: boolean): void {
  maintenanceMode = enabled;
}

export function setGlobalPause(paused: boolean): void {
  globalPaused = paused;
}

export function isGlobalPaused(): boolean {
  return globalPaused;
}

export function isMaintenanceMode(): boolean {
  return maintenanceMode;
}

// ── Auth Middleware ───────────────────────────────────────

/**
 * Core authentication middleware.
 * 1. Extract Telegram user ID
 * 2. Load/init workspace
 * 3. Check ban status
 * 4. Check maintenance mode (bypass for owner)
 */
export function authMiddleware(): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return; // Ignore anonymous updates

    const telegramId = String(userId);
    const ownerId = process.env.TELEGRAM_OWNER_ID;
    const isOwner = telegramId === ownerId;

    // Load or initialize workspace
    let config = loadConfig(telegramId);
    if (!config.telegramId) {
      initWorkspace(telegramId);
      config = loadConfig(telegramId);
    }

    // Ban check
    if (config.isBanned && !isOwner) {
      await ctx.reply('🚫 You are banned from using this bot.').catch(() => {});
      return;
    }

    // Maintenance mode — owner only
    if (maintenanceMode && !isOwner) {
      await ctx.reply(
        '🔧 *Bot is under maintenance.* Please try again later.',
        { parse_mode: 'Markdown' }
      ).catch(() => {});
      return;
    }

    // Attach to context for downstream use
    (ctx as Context & { telegramId: string; isOwner: boolean; userConfig: typeof config }).telegramId = telegramId;
    (ctx as Context & { isOwner: boolean }).isOwner = isOwner;
    (ctx as Context & { userConfig: typeof config }).userConfig = config;

    logger.debug(`[Auth] User ${telegramId} (owner=${isOwner}) → ${ctx.updateType}`);

    return next();
  };
}

// ── Force-Join Middleware ─────────────────────────────────

/**
 * Verifies that the user is a member of the designated sponsor channel.
 * Skips owner and if TELEGRAM_SPONSOR_CHANNEL is not configured.
 */
export function forceJoinMiddleware(): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const sponsorChannel = process.env.TELEGRAM_SPONSOR_CHANNEL;
    if (!sponsorChannel) return next();

    const isOwner = (ctx as Context & { isOwner?: boolean }).isOwner;
    if (isOwner) return next();

    const userId = ctx.from?.id;
    if (!userId) return next();

    try {
      const member = await ctx.telegram.getChatMember(sponsorChannel, userId);
      const activeStatuses = ['member', 'creator', 'administrator'];

      if (!activeStatuses.includes(member.status)) {
        await ctx.reply(
          `⚠️ <b>Access Restricted</b>\n\nYou must join our channel first:\n${sponsorChannel}`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '📢 Join Channel', url: `https://t.me/${sponsorChannel.replace('@', '')}`, style: 'primary' }],
                [{ text: '✅ I Joined', callback_data: 'verify:joined', style: 'success' }],
              ],
            },
          }
        ).catch(() => {});
        return;
      }
    } catch {
      // If we can't check (bot not admin), allow through
    }

    return next();
  };
}

// ── Owner Guard ───────────────────────────────────────────

/**
 * Middleware that only allows the owner to proceed.
 */
export function ownerOnly(): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const isOwner = (ctx as Context & { isOwner?: boolean }).isOwner;
    if (!isOwner) {
      await ctx.reply('🚫 This command is restricted to the bot owner.').catch(() => {});
      return;
    }
    return next();
  };
}
