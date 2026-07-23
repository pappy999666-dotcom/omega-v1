// ============================================================
// WA-Bridge — Admin Panel Telegram Handlers
// Platform governance, omni-bridge, master bucket, etc.
// ============================================================

import type { Context } from 'telegraf';
import { loadConfig, updateConfig, purgeAllSessions, loadBucket, getAllUserIds } from '../../services/workspace.js';
import { getAllSockets } from '../../whatsapp/socket-manager.js';
import { getMasterActiveBucket, exportBucket } from '../../services/tri-bucket.js';
import { enqueueJob, omniQueue } from '../../services/queue.js';
import { setMaintenanceMode, setGlobalPause } from '../middlewares/auth.js';
import {
  adminPanelKeyboard,
  adminUsersKeyboard,
  adminUserKeyboard,
  confirmKeyboard,
} from '../ui/keyboards.js';
import { header, H, kv, bucketCard } from '../../utils/formatter.js';
import { logger } from '../../utils/logger.js';

// ── Admin Panel ───────────────────────────────────────────

export async function handleAdminPanel(ctx: Context): Promise<void> {
  const sockets = getAllSockets();
  const users = getAllUserIds();

  const text = [
    header('Admin Control Panel', '👑'),
    '',
    kv('Active Sessions:', String(sockets.size)),
    kv('Total Users:', String(users.length)),
    kv('Platform:', '🟢 Online'),
  ].join('\n');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: adminPanelKeyboard(),
    }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: adminPanelKeyboard() });
  }
}

// ── User Management ───────────────────────────────────────

export async function handleAdminUsers(ctx: Context, page = 0): Promise<void> {
  const userIds = getAllUserIds();
  const users = userIds.map((id) => {
    const cfg = loadConfig(id);
    return { telegramId: id, username: cfg.username, isBanned: cfg.isBanned };
  });

  await ctx.editMessageText(
    `${header('User Management', '👥')}\n\n${H.italic(`${users.length} registered users`)}`,
    { parse_mode: 'HTML', reply_markup: adminUsersKeyboard(users, page) }
  ).catch(() => {});
}

export async function handleAdminUserMenu(ctx: Context, telegramId: string): Promise<void> {
  const cfg = loadConfig(telegramId);

  const text = [
    header(`User: ${cfg.username ?? telegramId}`, '🔍'),
    '',
    kv('Telegram ID:', H.code(telegramId)),
    kv('Status:', cfg.isBanned ? '🚫 Banned' : '✅ Active'),
    kv('Joined:', new Date(cfg.joinedAt).toLocaleDateString()),
    kv('Last Active:', new Date(cfg.lastActivity).toLocaleDateString()),
  ].join('\n');

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: adminUserKeyboard(telegramId, cfg.isBanned),
  }).catch(() => {});
}

export async function handleBanUser(
  ctx: Context,
  targetId: string,
  ban: boolean
): Promise<void> {
  updateConfig(targetId, { isBanned: ban });

  try {
    await ctx.telegram.sendMessage(
      parseInt(targetId, 10),
      ban
        ? '🚫 You have been banned from this bot.'
        : '✅ Your access has been restored.'
    );
  } catch {
    // User may have blocked the bot
  }

  await ctx.answerCbQuery(ban ? 'User banned' : 'User unbanned').catch(() => {});
  await handleAdminUserMenu(ctx, targetId);
}

// ── Inspect Workspace ─────────────────────────────────────

export async function handleInspectUser(ctx: Context, targetId: string): Promise<void> {
  const cfg = loadConfig(targetId);
  const main = loadBucket(targetId, 'main');
  const active = loadBucket(targetId, 'active');
  const dead = loadBucket(targetId, 'dead');

  const text = [
    header(`Workspace: ${cfg.username ?? targetId}`, '🔍'),
    '',
    kv('Sessions:', 'see /sessions'),
    kv('Main Bucket:', String(main.length)),
    kv('Active Bucket:', String(active.length)),
    kv('Dead Bucket:', String(dead.length)),
    kv('Prefix:', cfg.prefix || 'null'),
  ].join('\n');

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: `admin:user:${targetId}` }]] },
  }).catch(() => {});
}

// ── Purge User Sessions ───────────────────────────────────

export async function handlePurgeUserSessions(
  ctx: Context,
  targetId: string
): Promise<void> {
  await ctx.editMessageText(
    `${header('Confirm: Purge All Sessions', '⚠️')}\n\nThis will delete ALL sessions for user ${H.code(targetId)}.`,
    {
      parse_mode: 'HTML',
      reply_markup: confirmKeyboard(
        `admin:purge_confirm:${targetId}`,
        `admin:user:${targetId}`
      ),
    }
  ).catch(() => {});
}

export async function handlePurgeConfirm(ctx: Context, targetId: string): Promise<void> {
  purgeAllSessions(targetId);
  await ctx.answerCbQuery('Sessions purged').catch(() => {});
  await ctx.editMessageText(
    `${header('Purged', '🗑')}\n\nAll sessions for ${H.code(targetId)} have been deleted.`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'admin:users:0' }]] } }
  ).catch(() => {});
}

// ── Master Bucket ─────────────────────────────────────────

export async function handleMasterBucket(ctx: Context): Promise<void> {
  const userIds = getAllUserIds();
  const master = getMasterActiveBucket(userIds);

  const text = [
    header('Master Active Bucket', '🌐'),
    '',
    kv('Total Links:', String(master.length)),
    kv('From Users:', String(userIds.length)),
    '',
    H.blockquote(`Aggregates all Active bucket links from every user workspace.`),
  ].join('\n');

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📤 Export TXT', callback_data: 'admin:master:export:txt' }],
        [{ text: '🔙 Back', callback_data: 'admin:panel' }],
      ],
    },
  }).catch(() => {});
}

// ── Omni-Bridge ───────────────────────────────────────────

export async function handleOmniBridge(ctx: Context & { telegramId: string }): Promise<void> {
  await ctx.editMessageText(
    `${header('Omni-Bridge', '📡')}\n\n` +
    `Send a command to execute across ALL active sessions simultaneously.\n\n` +
    `${H.blockquote('Available commands:\n• broadcast [message] — send to groups\n• status [text] — post to status')}\n\n` +
    `Reply with: ${H.code('/omni [command] [text]')}`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'admin:panel' }]] } }
  ).catch(() => {});
}

export async function executeOmniCommand(
  ctx: Context & { telegramId: string },
  command: string,
  text: string
): Promise<void> {
  const jobId = await enqueueJob('wa:omni', {
    telegramId: ctx.telegramId,
    sessionId: 'omni',
    type: 'omni_bridge',
    data: { command, text },
    chatId: ctx.chat!.id,
  });

  await ctx.reply(
    `${header('Omni-Bridge Dispatched', '📡')}\n\n${H.code(jobId)}\n\nExecuting across all sessions…`,
    { parse_mode: 'HTML' }
  );
}

// ── Global Controls ───────────────────────────────────────

export async function handleGlobalPause(ctx: Context, paused: boolean): Promise<void> {
  setGlobalPause(paused);
  await ctx.answerCbQuery(paused ? 'Global pause ON' : 'Global pause OFF').catch(() => {});
  await ctx.editMessageText(
    `${header('Global Pause', paused ? '⏸' : '▶️')}\n\nAll user traffic is ${paused ? H.bold('PAUSED') : H.bold('RESUMED')}.`,
    { parse_mode: 'HTML', reply_markup: adminPanelKeyboard() }
  ).catch(() => {});
}

export async function handleMaintenanceToggle(ctx: Context, enabled: boolean): Promise<void> {
  setMaintenanceMode(enabled);
  await ctx.answerCbQuery(enabled ? 'Maintenance ON' : 'Maintenance OFF').catch(() => {});
  await ctx.editMessageText(
    `${header('Maintenance Mode', enabled ? '🔧' : '✅')}\n\n${enabled ? 'Bot is now in maintenance mode.' : 'Bot is back online.'}`,
    { parse_mode: 'HTML', reply_markup: adminPanelKeyboard() }
  ).catch(() => {});
}

// ── Platform Stats ────────────────────────────────────────

export async function handlePlatformStats(ctx: Context): Promise<void> {
  const sockets = getAllSockets();
  const userIds = getAllUserIds();
  const master = getMasterActiveBucket(userIds);

  let totalActive = 0;
  let totalFrozen = 0;
  for (const [, h] of sockets.entries()) {
    if (h.frozen) totalFrozen++;
    else totalActive++;
  }

  const text = [
    header('Platform Statistics', '📊'),
    '',
    kv('Total Users:', String(userIds.length)),
    kv('Active Sessions:', String(totalActive)),
    kv('Frozen Sessions:', String(totalFrozen)),
    kv('Master Active Links:', String(master.length)),
    kv('Uptime:', humanUptime()),
  ].join('\n');

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'admin:panel' }]] },
  }).catch(() => {});
}

function humanUptime(): string {
  const ms = process.uptime() * 1000;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}
