// ============================================================
// WA-Bridge — Auth & Gatekeeping Middleware
// Ban check, maintenance mode, force-join channel verification
// ============================================================

import type { Context, MiddlewareFn } from 'telegraf';

export interface SessionOnboardingDraft {
  stage: 'name' | 'phone' | 'method';
  label?: string;
  phone?: string;
  sessionId?: string;
}
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
      await ctx.reply(
        '🚫 <b>Access Denied</b>\n<code>──────────────────────────────</code>\n\n<blockquote>Your account is banned from using this bot.</blockquote>',
        { parse_mode: 'HTML' }
      ).catch(() => {});
      return;
    }

    // Maintenance mode — owner only
    if (maintenanceMode && !isOwner) {
      await ctx.reply(
        '🔧 <b>Maintenance Mode</b>\n<code>──────────────────────────────</code>\n\n<blockquote>The control center is temporarily unavailable. Please try again later.</blockquote>',
        { parse_mode: 'HTML' }
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
    const ownerId = process.env.TELEGRAM_OWNER_ID;
    const ownerConfigTargets = ownerId ? loadConfig(ownerId).forceJoinTargets ?? [] : [];
    const envTargets = (process.env.TELEGRAM_SPONSOR_CHANNELS ?? process.env.TELEGRAM_SPONSOR_CHANNEL ?? '')
      .split(',')
      .map((target) => target.trim())
      .filter(Boolean);
    const sponsorChannels = [...new Set([...ownerConfigTargets, ...envTargets])];
    if (sponsorChannels.length === 0) return next();

    const isOwner = (ctx as Context & { isOwner?: boolean }).isOwner;
    if (isOwner) return next();

    const userId = ctx.from?.id;
    if (!userId) return next();

    try {
      const activeStatuses = ['member', 'creator', 'administrator'];
      const missing: string[] = [];
      for (const sponsorChannel of sponsorChannels) {
        const member = await ctx.telegram.getChatMember(sponsorChannel, userId);
        if (!activeStatuses.includes(member.status)) missing.push(sponsorChannel);
      }

      if (missing.length > 0) {
        await ctx.reply(
          `⚠️ <b>Access Restricted</b>\n\nYou must join these channels/groups first:\n${missing.join('\n')}`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                ...missing.filter((target) => target.startsWith('@')).map((target) => [{ text: `📢 Join ${target}`, url: `https://t.me/${target.replace('@', '')}` }]),
                [{ text: '✅ I Joined', callback_data: 'verify:joined' }],
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
      await ctx.reply(
        '🔒 <b>Owner Only</b>\n<code>──────────────────────────────</code>\n\n<blockquote>This control is restricted to the bot owner.</blockquote>',
        { parse_mode: 'HTML' }
      ).catch(() => {});
      return;
    }
    return next();
  };
}
